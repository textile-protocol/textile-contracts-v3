// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { VaultLib } from "../libraries/VaultLib.sol";

/**
 * @title IOperatorVault
 * @notice External surface for the RFQ operator vault. Request/claim is custom: a settled
 *         redeem pays settlement and corridor, so ERC-7540 `deposit`/`mint`/`withdraw`/`redeem`
 *         and the preview methods are not implemented.
 */
interface IOperatorVault {
  /// @dev Every vault event lives here: several are emitted from VaultPolicy delegatecalls
  ///      and would otherwise be missing from the vault ABI.
  event SettlementPrepared(uint256 needed, uint256 recalled);
  event IdleAllocated(uint256 assets);
  event IdleRecalled(uint256 assets);
  /// @notice The deferred emergency slice finally crossed out of the adapter.
  event YieldPullSynced(uint256 assets);
  event ClaimedYield(
    address indexed controller, address indexed receiver, uint256 indexed epochId, uint256 yieldOut
  );
  event StrategySignerRotated(address indexed previous, address indexed current, uint256 tradingEpoch);
  event RiskSignerProposed(address indexed pending, uint256 applyAt);
  event RiskSignerRotated(address indexed previous, address indexed current, uint256 tradingEpoch);
  event RiskSignerProposalCancelled(address indexed cancelled);
  event OperatorAdminProposed(address indexed pending);
  event OperatorAdminProposalCancelled(address indexed cancelled);
  event OperatorAdminTransferred(address indexed previous, address indexed current);
  event RiskAdminProposed(address indexed pending);
  event RiskAdminProposalCancelled(address indexed cancelled);
  event RiskAdminTransferred(address indexed previous, address indexed current);
  event GuardianUpdated(address indexed previous, address indexed current);
  event FeeRecipientUpdated(address indexed previous, address indexed current);
  /// @notice The earliest event on a vault names the deploy-time floor as `previous`.
  event MinLiquidSettlementUpdated(uint256 previous, uint256 current);
  event FeeAccrued(address indexed recipient, uint256 shares, uint256 elapsed);
  /// @notice A performance-fee mark moved; all three are logged (WAD per share, basket legs in atomic units).
  event MarkUpdated(uint256 markWad, uint256 markSettlementWad, uint256 markCorridorWad);
  event NavSettled(uint256 nav, uint256 timestamp);
  event OperatorSet(address indexed account, address indexed operator, bool approved);
  /// @param account The guardian, or whoever ran the timed-out emergency exit.
  event Paused(address indexed account);
  event Unpaused(address indexed guardian);
  event TokenSwept(address indexed token, address indexed to, uint256 amount);
  event ETHSwept(address indexed to, uint256 amount);

  function requestDeposit(uint256 assets, address controller, address owner)
    external
    returns (uint256 requestId);

  /// @notice Queue a corridor-asset deposit. Corridor deposits run in their own epochs, sit
  ///         outside `freeCorridor` until processed, and are then priced at the attested
  ///         corridor price. Reverts `CorridorDepositsDisabled` when `minDepositCorridor` is zero.
  function requestDepositCorridor(uint256 assets, address controller, address owner)
    external
    returns (uint256 requestId);

  function cancelDeposit(uint256 requestId, address controller) external;

  /// @notice Queue a redemption. Minimum `minRedeemShares`, unless it is the owner's whole balance.
  function requestRedeem(uint256 shares, address controller, address owner)
    external
    returns (uint256 requestId);

  /// @notice Pay a processed or settled request out to `receiver`. The vault itself is refused.
  function claim(uint256 requestId, address controller, address receiver) external;

  function setOperator(address operator, bool approved) external returns (bool);

  function closeDepositEpoch(uint256 epochId) external;

  function processDepositEpoch(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata strategySignature,
    bytes calldata riskSignature
  ) external;

  function voidDepositEpoch(uint256 epochId) external;

  /// @notice Close the open redeem epoch. Bumps the trading epoch (every signed order dies) and
  ///         holds the vault close-only until the epoch settles. The operator admin and
  ///         strategy signer may close at any time; anyone else only once the epoch has been
  ///         open `redemptionEpochDuration + valuationTimeout` and `redemptionCloseCooldown`
  ///         has passed since the last settle.
  function closeRedeemEpoch(uint256 epochId) external;

  /// @notice Settle a closed redeem epoch against a dual-signed attestation. Redeemers are paid
  ///         both assets pro rata to their share of supply, off the attested free balances.
  ///         Settling while paused pays live balances instead, and a full-supply exit requires the pause.
  function settleRedeemEpoch(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata strategySignature,
    bytes calldata riskSignature
  ) external;

  /// @notice Last-resort in-kind redeem when the signers cannot attest, once
  ///         `emergencyExitTimeout` has elapsed since the epoch closed. Anyone may call.
  ///         Pauses the vault if the guardian has not, then pays live free balances. A
  ///         position the adapter cannot pay back becomes a pro-rata in-kind claim on the
  ///         yield token, collected at claim time.
  function settleRedeemEmergencyInKind(uint256 epochId) external;

  /// @notice In-kind yield bookkeeping for emergency exits, in the adapter's scaled units.
  /// @return weight Unclaimed claim weight over the vault's yield-token balance.
  /// @return pendingPull Position owed to redeemers that could not leave the adapter yet.
  ///         Excluded from NAV and off-limits to every recall.
  function yieldReserves() external view returns (uint256 weight, uint256 pendingPull);

  /// @notice Guardian-only sweep of a non-working ERC-20. Reverts for the share token, both
  ///         assets, and the yield token.
  function sweepToken(address token, address to) external;

  /// @notice Guardian-only sweep of forced-in ETH.
  function sweepETH(address payable to) external;

  /// @notice Recall enough settlement from the yield adapter so at least `needed` sits liquid.
  ///         Reverts `InsufficientSettlement` when the recall comes up short. Anyone may call.
  /// @dev Not atomic with a later fill: anyone can `allocateIdle` in between and make the fill
  ///      revert. Griefing only; fill through `VaultOrderExecutor.fill` when that matters.
  function prepareSettlement(uint256 needed) external;

  /// @notice Supply idle settlement above `minLiquidSettlement` to the yield adapter. No-op
  ///         when the adapter is unset, the vault is paused, or close-only. Anyone may call.
  function allocateIdle() external;

  /// @notice Recall the full adapter position back to the vault. Anyone may call.
  function recallAll() external;

  function settlementAsset() external view returns (IERC20);
  /// @notice The OperatorVaultFactory that deployed this vault. Carries the protocol fee cut
  ///         and the implementation `VERSION()`.
  function factory() external view returns (address);
  function corridorAsset() external view returns (IERC20);
  function reactor() external view returns (address);
  function permit2() external view returns (address);
  function preferredFillerValidation() external view returns (address);
  function maxOrderLifetime() external view returns (uint256);
  function maxOrderInputSettlement() external view returns (uint256);
  function maxOrderInputCorridor() external view returns (uint256);
  function operatorAdmin() external view returns (address);
  function pendingOperatorAdmin() external view returns (address);
  function strategySigner() external view returns (address);
  function riskAdmin() external view returns (address);
  function pendingRiskAdmin() external view returns (address);
  function riskSigner() external view returns (address);
  function pendingRiskSigner() external view returns (address);
  function pendingRiskSignerAt() external view returns (uint256);
  function guardian() external view returns (address);
  function feeRecipient() external view returns (address);
  function settlementDecimals() external view returns (uint8);
  function corridorDecimals() external view returns (uint8);
  function perfFloorEnabled() external view returns (bool);
  function tradingEpoch() external view returns (uint256);
  function paused() external view returns (bool);
  function closeOnly() external view returns (bool);
  /// @notice Economic free settlement: liquid plus the adapter position.
  function freeSettlement() external view returns (uint256);
  /// @notice Settlement in the vault net of pending and reserved: the only balance Permit2
  ///         can pull from. `prepareSettlement` first to count held funds.
  function liquidSettlement() external view returns (uint256);
  /// @notice Corridor net of pending deposits and reserved payouts.
  function freeCorridor() external view returns (uint256);
  function quotableSettlement() external view returns (uint256);
  function quotableCorridor() external view returns (uint256);
  /// @notice Last settled NAV, not a live mark.
  function totalAssets() external view returns (uint256);
}
