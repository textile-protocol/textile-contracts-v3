// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Constructor / factory payloads and shared storage structs for OperatorVault.
library VaultTypes {
  /// @notice Performance-fee benchmarks in WAD atomic units per share.
  /// @dev `highWaterWad` uses settlement units and cannot decrease while supply is nonzero;
  ///      an empty-supply checkpoint resets it to one WAD. Basket components use each asset's
  ///      own units. Full-width storage prevents saturation from understating the fee threshold.
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
    /// @dev Epoch durations run from opening; valuation and emergency timeouts run from close.
    ///      The redemption close cooldown runs from the previous redemption settlement.
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
    /// @dev Require NAV to exceed the absolute high-water mark as well as the revalued basket.
    bool perfFloorEnabled;
  }

  /// @notice Full constructor payload: immutable terms plus initial roles and liquid-settlement floor.
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
