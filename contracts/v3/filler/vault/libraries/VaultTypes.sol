// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Constructor / factory payloads and shared storage structs for OperatorVault.
library VaultTypes {
  /// @notice Performance-fee marks. `highWaterWad` is the absolute mark, WAD assets per share,
  ///         and only ever rises. The basket legs are WAD-scaled atomic units of each asset per
  ///         share, full width, since a leg that saturated would understate the basket and
  ///         re-charge it.
  struct Marks {
    uint256 highWaterWad;
    uint256 settlementWad;
    uint256 corridorWad;
  }

  /// @notice One storage struct so the admin lifecycle can live in the linked library.
  struct Roles {
    address operatorAdmin;
    address pendingOperatorAdmin;
    address strategySigner;
    address riskAdmin;
    address pendingRiskAdmin;
    address riskSigner;
    address pendingRiskSigner;
    /// @dev Packs with `pendingRiskSigner`; the two are always written and cleared together.
    uint96 pendingRiskSignerAt;
    address guardian;
    address feeRecipient;
  }

  /// @notice Caller-supplied vault configuration. The factory fills in reactor, Permit2 and
  ///         PreferredFillerValidation.
  struct VaultInit {
    string name;
    string symbol;
    IERC20 settlementAsset;
    IERC20 corridorAsset;
    address operatorAdmin;
    address strategySigner;
    address riskAdmin;
    address riskSigner;
    address guardian;
    address feeRecipient;
    uint256 maxOrderInputSettlement;
    uint256 maxOrderInputCorridor;
    uint256 minReserveSettlement;
    uint256 minReserveCorridor;
    uint256 maxOrderLifetime;
    /// @dev Durations run from the epoch opening, timeouts from its close.
    uint256 depositEpochDuration;
    uint256 redemptionEpochDuration;
    uint256 redemptionCloseCooldown;
    uint256 emergencyExitTimeout;
    uint256 valuationTimeout;
    uint256 managementFeeWad;
    /// @dev Share of NAV over the basket mark, the last-charged inventory revalued at the attested
    ///      price. Capped at NAV over the all-time high when `perfFloorEnabled`. WAD; zero = off.
    uint256 performanceFeeWad;
    /// @dev Textile's cut of each fee leg, WAD. Held on the factory, not the vault.
    uint256 protocolManagementShareWad;
    uint256 protocolPerformanceShareWad;
    uint256 riskSignerDelay;
    uint256 minDepositAssets;
    /// @dev In corridor atomic units. Zero disables corridor deposits for the vault's whole life.
    uint256 minDepositCorridor;
    uint256 minRedeemShares;
    bool enableYield;
    uint256 minLiquidSettlement;
    /// @dev Adds the all-time-high price per share as a second bar under the performance fee.
    bool perfFloorEnabled;
  }

  /// @notice Full immutable constructor payload.
  struct VaultConfig {
    IERC20 settlementAsset;
    IERC20 corridorAsset;
    address reactor;
    address permit2;
    address preferredFillerValidation;
    address operatorAdmin;
    address strategySigner;
    address riskAdmin;
    address riskSigner;
    address guardian;
    address feeRecipient;
    uint256 maxOrderInputSettlement;
    uint256 maxOrderInputCorridor;
    uint256 minReserveSettlement;
    uint256 minReserveCorridor;
    uint256 maxOrderLifetime;
    uint256 depositEpochDuration;
    uint256 redemptionEpochDuration;
    uint256 redemptionCloseCooldown;
    uint256 emergencyExitTimeout;
    uint256 valuationTimeout;
    uint256 managementFeeWad;
    uint256 performanceFeeWad;
    uint256 riskSignerDelay;
    uint256 minDepositAssets;
    uint256 minDepositCorridor;
    uint256 minRedeemShares;
    address yieldAdapter;
    uint256 minLiquidSettlement;
    bool perfFloorEnabled;
  }
}
