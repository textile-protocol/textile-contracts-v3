// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";

import { LimitOrder } from "../../vendor/uniswapx/lib/LimitOrderLib.sol";
import { OutputToken } from "../../vendor/uniswapx/base/ReactorStructs.sol";

import { FillerConstants } from "../../FillerConstants.sol";

import { IOperatorVault } from "../interfaces/IOperatorVault.sol";
import { IOperatorVaultFactory } from "../interfaces/IOperatorVaultFactory.sol";
import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";
import { VaultErrors } from "./VaultErrors.sol";
import { VaultLib } from "./VaultLib.sol";
import { VaultTypes } from "./VaultTypes.sol";

interface IVaultSignatureSource {
  function reactor() external view returns (address);
  function permit2() external view returns (address);
  function preferredFillerValidation() external view returns (address);
  function tradingEpoch() external view returns (uint256);
  function maxOrderLifetime() external view returns (uint256);
  function settlementAsset() external view returns (address);
  function corridorAsset() external view returns (address);
  function settlementDecimals() external view returns (uint8);
  function corridorDecimals() external view returns (uint8);
  function maxOrderInputSettlement() external view returns (uint256);
  function maxOrderInputCorridor() external view returns (uint256);
  function fillPriceBand() external view returns (uint256);
  function quotableSettlement() external view returns (uint256);
  function liquidSettlement() external view returns (uint256);
  function quotableCorridor() external view returns (uint256);
  function closeOnly() external view returns (bool);
  function strategySigner() external view returns (address);
  function riskSigner() external view returns (address);
}

/// @notice Linked library: order policy, constructor checks, and yield-adapter
///         plumbing. Kept out of OperatorVault so the factory stays under the
///         24kb runtime cap. Non-view functions run as delegatecalls from the
///         vault, so the adapter always sees the vault as caller.
library VaultPolicy {
  using SafeERC20 for IERC20;

  uint256 internal constant MAX_MANAGEMENT_FEE_WAD = 1e17;
  uint8 internal constant MAX_TOKEN_DECIMALS = 18;

  struct OrderContext {
    address reactor;
    address vault;
    address preferredFillerValidation;
    uint256 tradingEpoch;
    uint256 maxOrderLifetime;
    address settlementAsset;
    address corridorAsset;
    uint8 settlementDecimals;
    uint8 corridorDecimals;
    uint256 maxOrderInputSettlement;
    uint256 maxOrderInputCorridor;
    uint256 minFillPriceWad;
    uint256 maxFillPriceWad;
    uint256 quotableSettlement;
    uint256 quotableCorridor;
    bool closeOnly;
  }

  /// @notice Constructor-time config validation. Decimals are the only token
  ///         property checked on-chain (audit L-04): standardness — no
  ///         rebasing, no fee-on-transfer — is a deployment requirement the
  ///         operator must vet per asset, not something this can enforce.
  /// @return settlementDecimals_ The settlement asset's decimals.
  /// @return corridorDecimals_ The corridor asset's decimals. Both returned
  ///         so the constructor does not repeat the external reads.
  function validateConfig(VaultTypes.VaultConfig memory cfg)
    external
    view
    returns (uint8 settlementDecimals_, uint8 corridorDecimals_)
  {
    if (
      address(cfg.settlementAsset) == address(0) || address(cfg.corridorAsset) == address(0)
        || cfg.reactor == address(0) || cfg.permit2 == address(0) || cfg.preferredFillerValidation == address(0)
        || cfg.operatorAdmin == address(0) || cfg.strategySigner == address(0) || cfg.riskAdmin == address(0)
        || cfg.riskSigner == address(0) || cfg.guardian == address(0) || cfg.feeRecipient == address(0)
    ) revert VaultErrors.ZeroAddress();
    if (address(cfg.settlementAsset) == address(cfg.corridorAsset)) revert VaultErrors.InvalidPair();
    if (cfg.strategySigner == cfg.riskSigner) revert VaultErrors.InvalidParams();
    // One entity holding both admin roles could rotate both signers and
    // collapse the dual-signature model to a single party.
    if (cfg.operatorAdmin == cfg.riskAdmin) revert VaultErrors.InvalidParams();
    if (
      cfg.maxOrderInputSettlement == 0 || cfg.maxOrderInputCorridor == 0 || cfg.maxOrderLifetime == 0
        || cfg.depositEpochDuration == 0 || cfg.redemptionEpochDuration == 0 || cfg.redemptionCloseCooldown == 0
        || cfg.inKindExitTimeout == 0 || cfg.emergencyExitTimeout == 0 || cfg.valuationTimeout == 0
        || cfg.riskSignerDelay == 0 || cfg.minDepositAssets == 0 || cfg.minRedeemShares == 0 || cfg.version == 0
    ) revert VaultErrors.InvalidParams();
    if (cfg.emergencyExitTimeout <= cfg.inKindExitTimeout) revert VaultErrors.InvalidParams();
    // Band prices pack into 128 bits each; 2^128 WAD ≈ 3.4e20 whole
    // settlement per corridor, far beyond any real market.
    if (
      cfg.minFillPriceWad == 0 || cfg.maxFillPriceWad < cfg.minFillPriceWad
        || cfg.maxFillPriceWad >> 128 != 0
    ) revert VaultErrors.InvalidParams();
    if (cfg.yieldAdapter == address(0) && cfg.minLiquidSettlement != 0) revert VaultErrors.InvalidParams();
    _requireSafeDuration(cfg.depositEpochDuration);
    _requireSafeDuration(cfg.redemptionEpochDuration);
    _requireSafeDuration(cfg.redemptionCloseCooldown);
    _requireSafeDuration(cfg.inKindExitTimeout);
    _requireSafeDuration(cfg.emergencyExitTimeout);
    _requireSafeDuration(cfg.valuationTimeout);
    _requireSafeDuration(cfg.riskSignerDelay);
    if (cfg.managementFeeWad > MAX_MANAGEMENT_FEE_WAD) revert VaultErrors.InvalidParams();
    settlementDecimals_ = _requireDecimals(address(cfg.settlementAsset));
    corridorDecimals_ = _requireDecimals(address(cfg.corridorAsset));
  }

  /// @notice Bind a freshly cloned adapter to the calling vault and approve it
  ///         for the settlement asset only.
  /// @return yieldToken Token the adapter position is held in.
  function bindYieldAdapter(address adapter, IERC20 settlement) external returns (address yieldToken) {
    IYieldAdapter(adapter).initialize(address(this), address(settlement));
    settlement.forceApprove(adapter, type(uint256).max);
    return IYieldAdapter(adapter).yieldToken();
  }

  /// @notice Recall enough from the adapter so at least `needed` is liquid.
  ///         Strict: a shortfall of even 1 wei reverts, so a fill can never
  ///         pull against a short balance.
  function prepareIdle(IYieldAdapter adapter, uint256 liquid, uint256 needed) external {
    if (liquid >= needed) return;
    if (address(adapter) == address(0)) revert VaultErrors.InsufficientSettlement();
    uint256 gap = needed - liquid;
    uint256 withdrawn = adapter.recall(gap);
    if (withdrawn < gap) revert VaultErrors.InsufficientSettlement();
    emit IOperatorVault.SettlementPrepared(needed, withdrawn);
  }

  /// @notice Supply idle settlement above the floor. `halted` (paused or
  ///         close-only) makes it a no-op.
  function allocateIdle(IYieldAdapter adapter, uint256 liquid, uint256 minLiquid, bool halted) external {
    if (address(adapter) == address(0) || halted || liquid <= minLiquid) return;
    uint256 assets = liquid - minLiquid;
    adapter.deploy(assets);
    emit IOperatorVault.IdleAllocated(assets);
  }

  /// @notice Recall the full adapter position. No-op when nothing is held.
  function recallAllIdle(IYieldAdapter adapter) external {
    if (address(adapter) == address(0) || adapter.held() == 0) return;
    uint256 withdrawn = adapter.recall(type(uint256).max);
    emit IOperatorVault.IdleRecalled(withdrawn);
  }

  /// @notice Best-effort full recall for the emergency exit. An impaired Aave
  ///         reserve must not revert the last-resort settlement, so a failed
  ///         withdrawal is swallowed and the position still stranded in the
  ///         adapter is reported back for in-kind distribution.
  /// @return stranded Underlying value still held by the adapter afterwards.
  function tryRecallAllIdle(IYieldAdapter adapter) external returns (uint256 stranded) {
    if (address(adapter) == address(0) || adapter.held() == 0) return 0;
    try adapter.recall(type(uint256).max) returns (uint256 withdrawn) {
      emit IOperatorVault.IdleRecalled(withdrawn);
    } catch {} // solhint-disable-line no-empty-blocks
    return adapter.held();
  }

  function orderPolicyOk(LimitOrder memory order, OrderContext memory ctx) external view returns (bool) {
    return _orderPolicyOk(order, ctx);
  }

  function _orderPolicyOk(LimitOrder memory order, OrderContext memory ctx) private view returns (bool) {
    if (address(order.info.reactor) != ctx.reactor) return false;
    if (order.info.swapper != ctx.vault) return false;
    if (address(order.info.additionalValidationContract) != ctx.preferredFillerValidation) return false;
    if (VaultLib.epochFromNonce(order.info.nonce) != ctx.tradingEpoch) return false;
    if (order.info.deadline <= block.timestamp) return false;
    if (order.info.deadline - block.timestamp > ctx.maxOrderLifetime) return false;
    if (order.outputs.length != 1) return false;

    OutputToken memory output = order.outputs[0];
    if (output.recipient != ctx.vault) return false;
    if (output.amount == 0 || order.input.amount == 0) return false;
    // Explicit invariant (audit I-03): `permit2Digest` rebuilds the Permit2
    // token-permissions hash from `input.amount` while Permit2 signs over
    // `maxAmount`, so only equal-amount (non-decaying) inputs can ever match.
    // Assert it here so a future Dutch-input change fails loudly in review,
    // not silently at fill time.
    if (order.input.amount != order.input.maxAmount) return false;

    address inputToken = address(order.input.token);
    bool sellSettlement = inputToken == ctx.settlementAsset && output.token == ctx.corridorAsset;
    bool sellCorridor = inputToken == ctx.corridorAsset && output.token == ctx.settlementAsset;
    if (!sellSettlement && !sellCorridor) return false;

    uint256 cap = sellSettlement ? ctx.maxOrderInputSettlement : ctx.maxOrderInputCorridor;
    if (order.input.amount > cap) return false;

    uint256 available = sellSettlement ? ctx.quotableSettlement : ctx.quotableCorridor;
    if (order.input.amount > available) return false;
    if (ctx.closeOnly && !sellCorridor) return false;

    // Economic backstop (audit M-01): even a dual-signed order cannot price
    // the pair outside the vault's immutable band. `VaultLib.nav` with zero
    // settlement values a corridor amount in settlement atoms at a WAD price,
    // the same convention as the NAV attestation.
    if (sellSettlement) {
      uint256 maxIn = VaultLib.nav(
        0, output.amount, ctx.maxFillPriceWad, ctx.settlementDecimals, ctx.corridorDecimals
      );
      if (order.input.amount > maxIn) return false;
    } else {
      uint256 minOut = VaultLib.nav(
        0, order.input.amount, ctx.minFillPriceWad, ctx.settlementDecimals, ctx.corridorDecimals
      );
      if (output.amount < minOut) return false;
    }

    (address[] memory fillers, uint256 exclusiveUntil) =
      abi.decode(order.info.additionalValidationData, (address[], uint256));
    uint256 count = fillers.length;
    if (
      count == 0 || count > FillerConstants.MAX_PREFERRED_FILLERS
        || exclusiveUntil < order.info.deadline
    ) return false;
    for (uint256 i = 0; i < count; ++i) {
      if (fillers[i] == address(0)) return false;
    }
    return true;
  }

  function validateEnvelope(bytes32 hash, bytes calldata signature, address vault)
    external
    view
    returns (bytes4)
  {
    IVaultSignatureSource src = IVaultSignatureSource(vault);
    (LimitOrder memory order, bytes memory operatorSig, bytes memory riskSig) =
      abi.decode(signature, (LimitOrder, bytes, bytes));
    if (order.outputs.length != 1) return VaultLib.ERC1271_FAIL;
    if (VaultLib.permit2Digest(order, src.permit2(), block.chainid) != hash) return VaultLib.ERC1271_FAIL;
    address settlement = src.settlementAsset();
    address corridor = src.corridorAsset();
    address inputToken = address(order.input.token);
    uint256 quotableS;
    uint256 quotableC;
    if (inputToken == settlement) {
      // Quoting prices economic inventory, but Permit2 can only pull what is
      // liquid — pending deposits and reserved payouts share the raw balance
      // and must never fund a fill. Held funds count only once
      // `prepareSettlement` has recalled them into the vault.
      quotableS = src.quotableSettlement();
      uint256 liquid = src.liquidSettlement();
      if (liquid < quotableS) quotableS = liquid;
    } else if (inputToken == corridor) {
      quotableC = src.quotableCorridor();
    }
    OrderContext memory ctx = _orderContext(src, vault);
    ctx.settlementAsset = settlement;
    ctx.corridorAsset = corridor;
    ctx.quotableSettlement = quotableS;
    ctx.quotableCorridor = quotableC;
    if (!_orderPolicyOk(order, ctx)) return VaultLib.ERC1271_FAIL;
    if (!VaultLib.isSigner(src.strategySigner(), hash, operatorSig)) return VaultLib.ERC1271_FAIL;
    if (!VaultLib.isSigner(src.riskSigner(), hash, riskSig)) return VaultLib.ERC1271_FAIL;
    return IERC1271.isValidSignature.selector;
  }

  /*//////////////////////////////////////////////////////////////
              ADMIN LIFECYCLE (delegatecalled by the vault)
  //////////////////////////////////////////////////////////////*/

  /// @notice One-shot role initialisation from the vault constructor.
  function initRoles(
    VaultTypes.Roles storage roles,
    address operatorAdmin,
    address strategySigner,
    address riskAdmin,
    address riskSigner,
    address guardian,
    address feeRecipient
  ) external {
    roles.operatorAdmin = operatorAdmin;
    roles.strategySigner = strategySigner;
    roles.riskAdmin = riskAdmin;
    roles.riskSigner = riskSigner;
    roles.guardian = guardian;
    roles.feeRecipient = feeRecipient;
  }

  function setStrategySigner(VaultTypes.Roles storage roles, address next, uint256 newTradingEpoch)
    external
  {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == roles.riskSigner || next == roles.pendingRiskSigner) revert VaultErrors.InvalidParams();
    address previous = roles.strategySigner;
    roles.strategySigner = next;
    emit IOperatorVault.StrategySignerRotated(previous, next, newTradingEpoch);
  }

  function proposeRiskSigner(VaultTypes.Roles storage roles, address next, uint256 delay) external {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == roles.strategySigner) revert VaultErrors.InvalidParams();
    roles.pendingRiskSigner = next;
    roles.pendingRiskSignerAt = block.timestamp + delay;
    emit IOperatorVault.RiskSignerProposed(next, roles.pendingRiskSignerAt);
  }

  function acceptRiskSigner(VaultTypes.Roles storage roles, uint256 newTradingEpoch) external {
    address next = roles.pendingRiskSigner;
    if (next == address(0) || next == roles.strategySigner) revert VaultErrors.InvalidParams();
    if (block.timestamp < roles.pendingRiskSignerAt) revert VaultErrors.RotationDelayPending();
    address previous = roles.riskSigner;
    roles.riskSigner = next;
    roles.pendingRiskSigner = address(0);
    roles.pendingRiskSignerAt = 0;
    emit IOperatorVault.RiskSignerRotated(previous, next, newTradingEpoch);
  }

  function cancelRiskSigner(VaultTypes.Roles storage roles) external {
    address pending = roles.pendingRiskSigner;
    if (pending == address(0)) revert VaultErrors.InvalidParams();
    roles.pendingRiskSigner = address(0);
    roles.pendingRiskSignerAt = 0;
    emit IOperatorVault.RiskSignerProposalCancelled(pending);
  }

  function proposeOperatorAdmin(VaultTypes.Roles storage roles, address next) external {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == roles.operatorAdmin || next == roles.riskAdmin) revert VaultErrors.InvalidParams();
    roles.pendingOperatorAdmin = next;
    emit IOperatorVault.OperatorAdminProposed(next);
  }

  /// @dev Runs as a delegatecall, so `msg.sender` is the account accepting
  ///      and the factory rekey call is made from the vault address.
  function acceptOperatorAdmin(
    VaultTypes.Roles storage roles,
    address factory,
    address settlementAsset,
    address corridorAsset
  ) external {
    address next = roles.pendingOperatorAdmin;
    if (msg.sender != next) revert VaultErrors.NotAuthorized();
    // Re-checked at accept: the risk admin may have changed since the
    // proposal, and the two admin roles must stay separate.
    if (next == roles.riskAdmin) revert VaultErrors.InvalidParams();
    roles.pendingOperatorAdmin = address(0);
    address previous = roles.operatorAdmin;
    IOperatorVaultFactory(factory).rekeyOperator(previous, next, settlementAsset, corridorAsset);
    roles.operatorAdmin = next;
    emit IOperatorVault.OperatorAdminTransferred(previous, next);
  }

  function proposeRiskAdmin(VaultTypes.Roles storage roles, address next) external {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == roles.riskAdmin || next == roles.operatorAdmin) revert VaultErrors.InvalidParams();
    roles.pendingRiskAdmin = next;
    emit IOperatorVault.RiskAdminProposed(next);
  }

  function acceptRiskAdmin(VaultTypes.Roles storage roles) external {
    address next = roles.pendingRiskAdmin;
    if (msg.sender != next) revert VaultErrors.NotAuthorized();
    if (next == roles.operatorAdmin) revert VaultErrors.InvalidParams();
    roles.pendingRiskAdmin = address(0);
    // A new risk admin must not inherit the old admin's pending signer.
    roles.pendingRiskSigner = address(0);
    roles.pendingRiskSignerAt = 0;
    emit IOperatorVault.RiskAdminTransferred(roles.riskAdmin, next);
    roles.riskAdmin = next;
  }

  function setGuardian(VaultTypes.Roles storage roles, address next) external {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    emit IOperatorVault.GuardianUpdated(roles.guardian, next);
    roles.guardian = next;
  }

  /// @notice Guardian sweep of a non-working ERC-20. Delegatecalled, so the
  ///         balance and transfer are the vault's own.
  function sweepToken(
    address token,
    address to,
    address settlementAsset,
    address corridorAsset,
    address yieldToken
  ) external {
    if (to == address(0)) revert VaultErrors.ZeroAddress();
    // yieldToken is zero when yield is off; sweeping token(0) is nonsense
    // either way, so the fourth comparison needs no zero-guard.
    if (
      token == address(this) || token == settlementAsset || token == corridorAsset
        || token == yieldToken
    ) revert VaultErrors.InvalidPair();
    uint256 amount = IERC20(token).balanceOf(address(this));
    if (amount == 0) revert VaultErrors.ZeroAmount();
    IERC20(token).safeTransfer(to, amount);
    emit IOperatorVault.TokenSwept(token, to, amount);
  }

  /// @notice Guardian sweep of forced-in ETH.
  function sweepETH(address payable to) external {
    if (to == address(0)) revert VaultErrors.ZeroAddress();
    if (to == address(this)) revert VaultErrors.InvalidParams();
    uint256 amount = address(this).balance;
    if (amount == 0) revert VaultErrors.ZeroAmount();
    Address.sendValue(to, amount);
    emit IOperatorVault.ETHSwept(to, amount);
  }

  /// @dev Field-by-field build keeps `validateEnvelope` off stack-too-deep.
  ///      Assets and quotable amounts are filled in by the caller, which
  ///      already holds them as locals.
  function _orderContext(IVaultSignatureSource src, address vault)
    private
    view
    returns (OrderContext memory ctx)
  {
    ctx.reactor = src.reactor();
    ctx.vault = vault;
    ctx.preferredFillerValidation = src.preferredFillerValidation();
    ctx.tradingEpoch = src.tradingEpoch();
    ctx.maxOrderLifetime = src.maxOrderLifetime();
    ctx.settlementDecimals = src.settlementDecimals();
    ctx.corridorDecimals = src.corridorDecimals();
    ctx.maxOrderInputSettlement = src.maxOrderInputSettlement();
    ctx.maxOrderInputCorridor = src.maxOrderInputCorridor();
    uint256 band = src.fillPriceBand();
    ctx.minFillPriceWad = band >> 128;
    ctx.maxFillPriceWad = uint128(band);
    ctx.closeOnly = src.closeOnly();
  }

  function verifyAttestation(
    VaultLib.NavAttestation calldata att,
    bytes calldata signature,
    uint256 epochId,
    address vault,
    address riskSigner
  ) external view returns (uint256 price) {
    if (att.vault != vault || att.chainId != block.chainid || att.epochId != epochId) {
      revert VaultErrors.InvalidAttestation();
    }
    if (block.timestamp < att.validAfter || block.timestamp > att.validUntil) revert VaultErrors.InvalidAttestation();
    if (att.corridorAssetPrice == 0) revert VaultErrors.InvalidAttestation();
    bytes32 digest = VaultLib.attestationDigest(att, vault, block.chainid);
    if (!VaultLib.isSigner(riskSigner, digest, signature)) revert VaultErrors.InvalidAttestation();
    return att.corridorAssetPrice;
  }

  function _requireDecimals(address token) private view returns (uint8 d) {
    d = IERC20Metadata(token).decimals();
    if (d == 0 || d > MAX_TOKEN_DECIMALS) revert VaultErrors.InvalidDecimals();
  }

  /// @dev Epoch timestamps are uint64. A duration that cannot be added to now
  ///      without overflowing that width bricks later close / timeout / rotation.
  function _requireSafeDuration(uint256 duration) private view {
    if (duration > type(uint64).max - block.timestamp) revert VaultErrors.InvalidParams();
  }
}
