// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { IAaveV3Pool } from "../filler/vault/adapters/IAaveV3Pool.sol";

/// @notice Rebasing aToken mock: balances are scaled units multiplied by the
///         pool's liquidity index, like real Aave v3 aTokens. Mint/burn take
///         underlying amounts and are pool-only.
/// @dev Rounding matters here and has bitten this vault before, so it mirrors
///      Aave's `WadRayMath` exactly: every face-value <-> scaled conversion is
///      `rayMul`/`rayDiv`, which round half up. A mock that floors makes a
///      face-value round trip look lossless when on-chain it is not.
contract ATokenMock {
  uint256 private constant RAY = 1e27;
  uint256 private constant HALF_RAY = 0.5e27;

  AaveV3PoolMock public immutable pool;
  mapping(address => uint256) public scaledBalanceOf;

  constructor(AaveV3PoolMock pool_) {
    pool = pool_;
  }

  modifier onlyPool() {
    require(msg.sender == address(pool), "ATokenMock: not pool");
    _;
  }

  function balanceOf(address user) external view returns (uint256) {
    return _rayMul(scaledBalanceOf[user], pool.liquidityIndex());
  }

  function mint(address user, uint256 amount) external onlyPool {
    scaledBalanceOf[user] += _rayDiv(amount, pool.liquidityIndex());
  }

  function burn(address user, uint256 amount) external onlyPool {
    uint256 scaled = _rayDiv(amount, pool.liquidityIndex());
    uint256 balance = scaledBalanceOf[user];
    scaledBalanceOf[user] = scaled > balance ? 0 : balance - scaled;
  }

  /// @notice Real aTokens are full ERC-20s; transfer moves face value and
  ///         routes through `Pool.finalizeTransfer`, whose reserve validation
  ///         rejects a paused reserve just like `withdraw` does.
  /// @dev `AToken._transfer` scales with `amount.rayDiv(index)` and the burn
  ///      in `withdraw` uses the same rounding, so asking to move a face
  ///      amount that a previous burn rounded away reverts on the scaled
  ///      balance. That is the deadlock `transferHeld`'s clamp exists for.
  function transfer(address to, uint256 amount) external returns (bool) {
    require(!pool.transferReverts(), "ATokenMock: transfer off");
    uint256 scaled = _rayDiv(amount, pool.liquidityIndex());
    require(scaled <= scaledBalanceOf[msg.sender], "ATokenMock: balance");
    scaledBalanceOf[msg.sender] -= scaled;
    scaledBalanceOf[to] += scaled;
    return true;
  }

  /// @dev Aave `WadRayMath.rayMul` / `rayDiv`: multiply/divide, round half up.
  function _rayMul(uint256 a, uint256 b) private pure returns (uint256) {
    return (a * b + HALF_RAY) / RAY;
  }

  function _rayDiv(uint256 a, uint256 b) private pure returns (uint256) {
    return (a * RAY + b / 2) / b;
  }
}

/// @notice Minimal Aave v3 pool mock for adapter tests. Interest is simulated
///         by bumping the liquidity index (and minting matching underlying to
///         the pool). Failure switches cover outage and short-withdraw cases.
contract AaveV3PoolMock is IAaveV3Pool {
  using SafeERC20 for IERC20;

  uint256 private constant RAY = 1e27;

  uint256 public liquidityIndex = RAY;
  mapping(address => address) public aTokenOf;
  bool public supplyReverts;
  bool public withdrawReverts;
  bool public transferReverts;
  uint256 public withdrawShaveWei;

  function createReserve(address asset) external returns (address aToken) {
    aToken = address(new ATokenMock(this));
    aTokenOf[asset] = aToken;
  }

  function setLiquidityIndex(uint256 index) external {
    liquidityIndex = index;
  }

  function setSupplyReverts(bool reverts) external {
    supplyReverts = reverts;
  }

  function setWithdrawReverts(bool reverts) external {
    withdrawReverts = reverts;
  }

  /// @notice A paused Aave reserve rejects withdrawals and aToken transfers
  ///         alike, so the two flags only ever move together.
  function setReservePaused(bool isPaused) external {
    withdrawReverts = isPaused;
    transferReverts = isPaused;
  }

  /// @notice Pay out `shaveWei` less than requested, like an index-rounding gap.
  function setWithdrawShaveWei(uint256 shaveWei) external {
    withdrawShaveWei = shaveWei;
  }

  /// @inheritdoc IAaveV3Pool
  function supply(address asset, uint256 amount, address onBehalfOf, uint16) external override {
    require(!supplyReverts, "AaveV3PoolMock: supply off");
    address aToken = aTokenOf[asset];
    require(aToken != address(0), "AaveV3PoolMock: no reserve");
    IERC20(asset).safeTransferFrom(msg.sender, address(this), amount);
    ATokenMock(aToken).mint(onBehalfOf, amount);
  }

  /// @inheritdoc IAaveV3Pool
  function withdraw(address asset, uint256 amount, address to) external override returns (uint256) {
    require(!withdrawReverts, "AaveV3PoolMock: withdraw off");
    ATokenMock aToken = ATokenMock(aTokenOf[asset]);
    uint256 balance = aToken.balanceOf(msg.sender);
    if (amount == type(uint256).max) amount = balance;
    require(amount > 0 && amount <= balance, "AaveV3PoolMock: bad amount");
    aToken.burn(msg.sender, amount);
    uint256 paid = amount > withdrawShaveWei ? amount - withdrawShaveWei : 0;
    IERC20(asset).safeTransfer(to, paid);
    return paid;
  }

  /// @inheritdoc IAaveV3Pool
  function getReserveData(address asset) external view override returns (ReserveDataLegacy memory data) {
    data.aTokenAddress = aTokenOf[asset];
  }

  /// @inheritdoc IAaveV3Pool
  function getReserveNormalizedIncome(address) external view override returns (uint256) {
    return liquidityIndex;
  }
}
