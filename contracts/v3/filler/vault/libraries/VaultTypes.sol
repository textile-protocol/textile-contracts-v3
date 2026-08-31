// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Constructor / factory payloads for OperatorVault.
library VaultTypes {
  /// @notice Admin, signer, and payout roles. Grouped in one storage struct
  ///         so the admin lifecycle can live in the linked policy library
  ///         (external library functions mutate it via delegatecall), keeping
  ///         the vault runtime under the 24kb cap.
  struct Roles {
    address operatorAdmin;
    address pendingOperatorAdmin;
    address strategySigner;
    address riskAdmin;
    address pendingRiskAdmin;
    address riskSigner;
    address pendingRiskSigner;
    uint256 pendingRiskSignerAt;
    address guardian;
    address feeRecipient;
  }

  /// @notice Caller-supplied vault configuration. Factory fills reactor, Permit2,
  ///         PreferredFillerValidation, and implementation version.
  struct VaultInit {
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
    uint256 minFillPriceWad;
    uint256 maxFillPriceWad;
    uint256 minReserveSettlement;
    uint256 minReserveCorridor;
    uint256 maxOrderLifetime;
    uint256 depositEpochDuration;
    uint256 redemptionEpochDuration;
    uint256 redemptionCloseCooldown;
    uint256 inKindExitTimeout;
    uint256 emergencyExitTimeout;
    uint256 valuationTimeout;
    uint256 managementFeeWad;
    uint256 riskSignerDelay;
    uint256 minDepositAssets;
    uint256 minRedeemShares;
    bool enableYield;
    uint256 minLiquidSettlement;
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
    uint256 minFillPriceWad;
    uint256 maxFillPriceWad;
    uint256 minReserveSettlement;
    uint256 minReserveCorridor;
    uint256 maxOrderLifetime;
    uint256 depositEpochDuration;
    uint256 redemptionEpochDuration;
    uint256 redemptionCloseCooldown;
    uint256 inKindExitTimeout;
    uint256 emergencyExitTimeout;
    uint256 valuationTimeout;
    uint256 managementFeeWad;
    uint256 riskSignerDelay;
    uint256 minDepositAssets;
    uint256 minRedeemShares;
    address yieldAdapter;
    uint256 minLiquidSettlement;
    uint256 version;
  }
}
