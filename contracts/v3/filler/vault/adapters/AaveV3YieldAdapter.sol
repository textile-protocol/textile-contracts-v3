// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";
import { VaultErrors } from "../libraries/VaultErrors.sol";
import { IAaveV3Pool } from "./IAaveV3Pool.sol";

/**
 * @title AaveV3YieldAdapter
 * @notice Puts a vault's idle settlement balance into an Aave v3 market. One
 *         implementation per market; the factory clones it per vault and the
 *         vault binds the clone in its constructor, so there is no front-run
 *         window. The adapter holds only aTokens — never the vault's working
 *         balance — and has no sweep or admin surface.
 */
contract AaveV3YieldAdapter is IYieldAdapter {
  using SafeERC20 for IERC20;

  uint16 private constant REFERRAL_CODE = 0;

  IAaveV3Pool public immutable pool;

  address public override vault;
  address public override asset;
  IERC20 public aToken;

  event AdapterInitialized(address indexed vault, address indexed asset, address indexed aToken);
  event Deployed(uint256 assets);
  event Recalled(uint256 requested, uint256 withdrawn);
  event HeldTransferred(address indexed to, uint256 assets);
  event Skimmed(address indexed token, uint256 amount);

  modifier onlyVault() {
    if (msg.sender != vault) revert VaultErrors.NotAuthorized();
    _;
  }

  constructor(IAaveV3Pool pool_) {
    if (address(pool_) == address(0)) revert VaultErrors.ZeroAddress();
    pool = pool_;
    // Lock the implementation itself; clones start with zeroed storage.
    vault = address(this);
  }

  /// @inheritdoc IYieldAdapter
  function initialize(address vault_, address asset_) external override {
    if (vault != address(0)) revert VaultErrors.AlreadyInitialized();
    if (vault_ == address(0) || asset_ == address(0)) revert VaultErrors.ZeroAddress();
    if (msg.sender != vault_) revert VaultErrors.NotAuthorized();
    address aTokenAddress = pool.getReserveData(asset_).aTokenAddress;
    if (aTokenAddress == address(0)) revert VaultErrors.ZeroAddress();

    vault = vault_;
    asset = asset_;
    aToken = IERC20(aTokenAddress);
    IERC20(asset_).forceApprove(address(pool), type(uint256).max);
    emit AdapterInitialized(vault_, asset_, aTokenAddress);
  }

  /// @inheritdoc IYieldAdapter
  function deploy(uint256 assets) external override onlyVault {
    if (assets == 0) revert VaultErrors.ZeroAmount();
    address asset_ = asset;
    IERC20(asset_).safeTransferFrom(msg.sender, address(this), assets);
    pool.supply(asset_, assets, address(this), REFERRAL_CODE);
    emit Deployed(assets);
  }

  /// @inheritdoc IYieldAdapter
  function recall(uint256 assets) external override onlyVault returns (uint256 withdrawn) {
    withdrawn = pool.withdraw(asset, assets, msg.sender);
    emit Recalled(assets, withdrawn);
  }

  /// @inheritdoc IYieldAdapter
  /// @dev aToken `balanceOf` is index-scaled, so interest is already included.
  ///      Face value (audit I-01): this cannot see an Aave impairment — if
  ///      aTokens trade below par, `held()`, live NAV, and the attestation
  ///      floors are all inflated together. Marking Aave risk down is the
  ///      risk signer's job via the attested NAV, not this adapter's.
  function held() external view override returns (uint256) {
    return aToken.balanceOf(address(this));
  }

  /// @inheritdoc IYieldAdapter
  function yieldToken() external view override returns (address) {
    return address(aToken);
  }

  /// @inheritdoc IYieldAdapter
  /// @dev aTokens transfer at face value, so `assets` is also the aToken amount.
  function transferHeld(address to, uint256 assets) external override onlyVault {
    aToken.safeTransfer(to, assets);
    emit HeldTransferred(to, assets);
  }

  /// @notice Recover a token force-sent to the adapter by pushing it to the
  ///         vault. Permissionless on purpose: the destination is fixed, so
  ///         the call can only move value into the vault — underlying is
  ///         socialised there, junk becomes guardian-sweepable — and the
  ///         adapter stays owner-free. The position itself is never skimmable.
  function skim(address token) external {
    if (token == address(aToken)) revert VaultErrors.InvalidPair();
    uint256 amount = IERC20(token).balanceOf(address(this));
    if (amount == 0) revert VaultErrors.ZeroAmount();
    IERC20(token).safeTransfer(vault, amount);
    emit Skimmed(token, amount);
  }
}
