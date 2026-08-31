// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

/// @notice Minimal vendored slice of the Aave v3 Pool ABI — just what
///         AaveV3YieldAdapter needs. Struct layout must match Aave's
///         `DataTypes.ReserveDataLegacy` exactly; only `aTokenAddress` is read.
interface IAaveV3Pool {
  struct ReserveConfigurationMap {
    uint256 data;
  }

  struct ReserveDataLegacy {
    ReserveConfigurationMap configuration;
    uint128 liquidityIndex;
    uint128 currentLiquidityRate;
    uint128 variableBorrowIndex;
    uint128 currentVariableBorrowRate;
    uint128 currentStableBorrowRate;
    uint40 lastUpdateTimestamp;
    uint16 id;
    address aTokenAddress;
    address stableDebtTokenAddress;
    address variableDebtTokenAddress;
    address interestRateStrategyAddress;
    uint128 accruedToTreasury;
    uint128 unbacked;
    uint128 isolationModeTotalDebt;
  }

  function supply(address asset, uint256 amount, address onBehalfOf, uint16 referralCode) external;

  /// @dev `amount == type(uint256).max` withdraws the full aToken balance.
  ///      Returns the underlying amount actually withdrawn.
  function withdraw(address asset, uint256 amount, address to) external returns (uint256);

  function getReserveData(address asset) external view returns (ReserveDataLegacy memory);
}
