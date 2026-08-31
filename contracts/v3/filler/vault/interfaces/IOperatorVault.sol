// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { VaultLib } from "../libraries/VaultLib.sol";

/**
 * @title IOperatorVault
 * @notice External surface for the RFQ operator vault. Request/claim is
 *         custom: a closed redeem can pay settlement and corridor, so
 *         ERC-7540 `deposit`/`mint`/`withdraw`/`redeem` are not implemented.
 *         Preview methods revert — there is no honest preview until an
 *         attestation exists.
 * @dev Not drop-in ERC-4626 (audit I-02): `preview*` revert, `totalAssets()`
 *      returns the last settled NAV (a stale mark, not a live value), and
 *      share price comes from risk-signer attestations. Integrate through
 *      the request/claim flow, never through 4626 conversion helpers.
 *
 *      Token assumptions (audit L-04): both assets must be standard ERC-20s
 *      with 1–18 decimals — no rebasing, no fee-on-transfer, no reentrant
 *      hooks. `_pullExact` rejects fee-on-transfer deposits, but a rebasing
 *      settlement asset silently desynchronises the pending/reserved
 *      accounting. Deploy vaults only for vetted, allowlisted assets.
 *
 *      Zero-NAV edge (audit I-04): attesting `nav == 0` while shares are
 *      outstanding makes the next processed deposit mint essentially the
 *      whole vault (correct for a total-loss reset, catastrophic otherwise).
 *      The live-NAV floor makes this reachable only in a genuine total-loss
 *      state; the risk signer must not attest zero NAV with non-zero supply
 *      unless a full reset is intended.
 */
interface IOperatorVault {
  /// @dev Emitted from VaultPolicy delegatecalls, so declared here to keep
  ///      them in the vault ABI.
  event SettlementPrepared(uint256 needed, uint256 recalled);
  event IdleAllocated(uint256 assets);
  event IdleRecalled(uint256 assets);
  event StrategySignerRotated(address indexed previous, address indexed current, uint256 tradingEpoch);
  event RiskSignerProposed(address indexed pending, uint256 applyAt);
  event RiskSignerRotated(address indexed previous, address indexed current, uint256 tradingEpoch);
  event RiskSignerProposalCancelled(address indexed cancelled);
  event OperatorAdminProposed(address indexed pending);
  event OperatorAdminTransferred(address indexed previous, address indexed current);
  event RiskAdminProposed(address indexed pending);
  event RiskAdminTransferred(address indexed previous, address indexed current);
  event GuardianUpdated(address indexed previous, address indexed current);
  event TokenSwept(address indexed token, address indexed to, uint256 amount);
  event ETHSwept(address indexed to, uint256 amount);

  function requestDeposit(uint256 assets, address controller, address owner)
    external
    returns (uint256 requestId);

  function cancelDeposit(uint256 requestId, address controller) external;

  function requestRedeem(uint256 shares, address controller, address owner)
    external
    returns (uint256 requestId);

  function claim(uint256 requestId, address controller, address receiver) external;

  function setOperator(address operator, bool approved) external returns (bool);

  function closeDepositEpoch(uint256 epochId) external;

  function processDepositEpoch(uint256 epochId, VaultLib.NavAttestation calldata attestation, bytes calldata signature)
    external;

  function voidDepositEpoch(uint256 epochId) external;

  function closeRedeemEpoch(uint256 epochId) external;

  function settleRedeemEpoch(uint256 epochId, VaultLib.NavAttestation calldata attestation, bytes calldata signature)
    external;

  function settleRedeemInKind(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata signature
  ) external;

  /// @notice Last-resort in-kind redeem when the risk signer cannot attest.
  ///         Vault must already be paused. `emergencyExitTimeout` must have
  ///         elapsed since the epoch closed. Pays live free balances,
  ///         including unattested surplus. Anyone may call. Attested in-kind
  ///         while paused also pays live, so a hostile risk key cannot
  ///         pre-settle a partial epoch at zero and block this path.
  ///         The adapter recall is best-effort: a position Aave cannot pay
  ///         back is distributed pro-rata as the yield token itself, so an
  ///         impaired external protocol cannot block this exit.
  /// @param epochId Closed redeem epoch to settle.
  function settleRedeemEmergencyInKind(uint256 epochId) external;

  /// @notice Guardian-only sweep of a non-working ERC-20. Reverts for the
  ///         vault share token, settlement asset, corridor asset, and yield
  ///         token (the vault holds yield tokens for redeemers after an
  ///         emergency exit under an impaired external protocol).
  /// @param token Token to transfer. Must not be a working asset.
  /// @param to Recipient. Cannot be the zero address.
  function sweepToken(address token, address to) external;

  /// @notice Guardian-only sweep of forced-in ETH.
  /// @param to Recipient. Cannot be the zero address or this vault.
  function sweepETH(address payable to) external;

  /// @notice Recall enough settlement from the yield adapter so at least
  ///         `needed` sits liquid in the vault. No-op when already covered.
  ///         Reverts with `InsufficientSettlement` when the recall comes up
  ///         short. Anyone may call; fillers call it before a Permit2 pull.
  /// @dev Not atomic with a later fill: between a prepare and a direct
  ///      `reactor.execute`, anyone can call `allocateIdle` and restake the
  ///      recalled settlement, making the fill revert. That is griefing only —
  ///      no funds are at risk — and costs the caller gas each block. Fill
  ///      through `VaultOrderExecutor.fill`, which prepares and executes in
  ///      one transaction, when that matters.
  /// @param needed Liquid settlement the caller is about to pull.
  function prepareSettlement(uint256 needed) external;

  /// @notice Supply idle settlement above `minLiquidSettlement` to the yield
  ///         adapter. No-op when the adapter is unset, the vault is paused, or
  ///         close-only. Anyone may call — including between someone else's
  ///         `prepareSettlement` and their fill (see the note there).
  function allocateIdle() external;

  /// @notice Recall the full adapter position back to the vault. No-op when
  ///         nothing is held. Anyone may call; redeem settlement runs it first.
  function recallAll() external;

  function settlementAsset() external view returns (IERC20);
  function corridorAsset() external view returns (IERC20);
  function strategySigner() external view returns (address);
  function riskSigner() external view returns (address);
  function tradingEpoch() external view returns (uint256);
  function paused() external view returns (bool);
  function closeOnly() external view returns (bool);
  /// @notice Economic free settlement: liquid plus the adapter position.
  function freeSettlement() external view returns (uint256);
  /// @notice Settlement sitting in the vault net of pending and reserved —
  ///         the only balance Permit2 can pull from. ERC-1271 caps settlement
  ///         input here; `prepareSettlement` first to count held funds.
  function liquidSettlement() external view returns (uint256);
  function freeCorridor() external view returns (uint256);
  function quotableSettlement() external view returns (uint256);
  function quotableCorridor() external view returns (uint256);
  function totalAssets() external view returns (uint256);
}
