// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { IAaveV3Pool } from "../filler/vault/adapters/IAaveV3Pool.sol";

/// @notice Rebasing aToken mock: balances are scaled units multiplied by the
///         pool's liquidity index, like real Aave v3 aTokens. Mint/burn take
///         underlying amounts and are pool-only.
contract ATokenMock {
  uint256 private constant RAY = 1e27;

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
    return (scaledBalanceOf[user] * pool.liquidityIndex()) / RAY;
  }

  function mint(address user, uint256 amount) external onlyPool {
    scaledBalanceOf[user] += (amount * RAY) / pool.liquidityIndex();
  }

  function burn(address user, uint256 amount) external onlyPool {
    uint256 scaled = Math.mulDiv(amount, RAY, pool.liquidityIndex(), Math.Rounding.Ceil);
    uint256 balance = scaledBalanceOf[user];
    scaledBalanceOf[user] = scaled > balance ? 0 : balance - scaled;
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
}
