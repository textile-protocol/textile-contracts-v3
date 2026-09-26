// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { Address } from "@openzeppelin/contracts/utils/Address.sol";
import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { LimitOrder } from "../../vendor/uniswapx/lib/LimitOrderLib.sol";
import { OutputToken } from "../../vendor/uniswapx/base/ReactorStructs.sol";

import { FillerConstants } from "../../FillerConstants.sol";

import { IOperatorVault } from "../interfaces/IOperatorVault.sol";
import { IOperatorVaultFactory } from "../interfaces/IOperatorVaultFactory.sol";
import { IYieldAdapter } from "../interfaces/IYieldAdapter.sol";
import { VaultErrors } from "./VaultErrors.sol";
import { VaultLib } from "./VaultLib.sol";
import { VaultTypes } from "./VaultTypes.sol";

/// @dev Vault getters used to limit attestation use to the epoch settlement window.
///      The return tuple must match the public `OperatorVault.epochs` getter.
interface IVaultEpochClock {
  function epochs(uint256 epochId)
    external
    view
    returns (
      uint8 state,
      bool isDeposit,
      uint64 openedAt,
      uint64 cutoff,
      uint64 closedAt,
      bool inCorridor,
      uint256 units,
      uint256 shares,
      uint256 remainingUnits,
      uint256 remainingSettlement,
      uint256 remainingCorridor,
      uint256 remainingYield
    );
  function valuationTimeout() external view returns (uint256);
  function emergencyExitTimeout() external view returns (uint256);
}

/// @notice Configuration, order validation, fee accounting, administration, and yield operations.
/// @dev Linked to keep OperatorVault within the deployment size limit. Delegatecalls use
///      the vault's storage and address; the vault entry points enforce caller permissions.
///      The linked library address is fixed in the vault bytecode and must be verified with it.
library VaultPolicy {
  using SafeERC20 for IERC20;

  /// @notice Maximum annual management-fee rate, WAD-scaled (25%).
  uint256 internal constant MAX_MANAGEMENT_FEE_WAD = 25e16;
  /// @notice Below 100% so `nav - feeAssets` in `performanceFeeShares` stays positive.
  uint256 internal constant MAX_PERFORMANCE_FEE_WAD = 50e16;
  uint8 internal constant MAX_TOKEN_DECIMALS = 18;
  /// @dev Reserves half the uint64 range for the timestamp added to each duration.
  uint256 internal constant MAX_DURATION = type(uint64).max / 2;

  struct OrderContext {
    address reactor;
    address vault;
    address preferredFillerValidation;
    uint256 tradingEpoch;
    uint256 maxOrderLifetime;
    address settlementAsset;
    address corridorAsset;
    uint256 maxOrderInputSettlement;
    uint256 maxOrderInputCorridor;
    uint256 quotableSettlement;
    uint256 quotableCorridor;
    bool closeOnly;
  }

  /// @notice Validate the constructor configuration and read the two asset precisions.
  /// @dev Pure checks precede token calls. Missing required addresses take precedence
  ///      over invalid pairs, roles, and numeric limits.
  /// @return settlementDecimals_ The settlement asset's decimals.
  /// @return corridorDecimals_ The corridor asset's decimals.
  function validateConfig(VaultTypes.VaultConfig memory cfg)
    external
    view
    returns (uint8 settlementDecimals_, uint8 corridorDecimals_)
  {
    _validateRequiredAddresses(cfg);
    if (address(cfg.settlementAsset) == address(cfg.corridorAsset)) revert VaultErrors.InvalidPair();
    if (cfg.strategySigner == cfg.riskSigner) revert VaultErrors.InvalidParams();
    if (cfg.operatorAdmin == cfg.riskAdmin) revert VaultErrors.InvalidParams();

    _validateMinimums(cfg);
    if (cfg.yieldAdapter == address(0) && cfg.minLiquidSettlement != 0) revert VaultErrors.InvalidParams();
    _validateTiming(cfg);
    if (cfg.managementFeeWad > MAX_MANAGEMENT_FEE_WAD || cfg.performanceFeeWad > MAX_PERFORMANCE_FEE_WAD) {
      revert VaultErrors.InvalidParams();
    }

    settlementDecimals_ = _requireDecimals(address(cfg.settlementAsset));
    corridorDecimals_ = _requireDecimals(address(cfg.corridorAsset));
  }

  /// @dev Assets, trading infrastructure, and roles are required. The yield adapter is optional.
  function _validateRequiredAddresses(VaultTypes.VaultConfig memory cfg) private pure {
    if (address(cfg.settlementAsset) == address(0) || address(cfg.corridorAsset) == address(0)) {
      revert VaultErrors.ZeroAddress();
    }
    if (cfg.reactor == address(0) || cfg.permit2 == address(0) || cfg.preferredFillerValidation == address(0)) {
      revert VaultErrors.ZeroAddress();
    }
    if (cfg.operatorAdmin == address(0) || cfg.strategySigner == address(0)) revert VaultErrors.ZeroAddress();
    if (cfg.riskAdmin == address(0) || cfg.riskSigner == address(0)) revert VaultErrors.ZeroAddress();
    if (cfg.guardian == address(0) || cfg.feeRecipient == address(0)) revert VaultErrors.ZeroAddress();
  }

  /// @dev Zero reserves and fees are allowed. A zero corridor-deposit minimum disables that path.
  function _validateMinimums(VaultTypes.VaultConfig memory cfg) private pure {
    if (cfg.maxOrderInputSettlement == 0 || cfg.maxOrderInputCorridor == 0 || cfg.maxOrderLifetime == 0) {
      revert VaultErrors.InvalidParams();
    }
    if (cfg.depositEpochDuration == 0 || cfg.redemptionEpochDuration == 0 || cfg.redemptionCloseCooldown == 0) {
      revert VaultErrors.InvalidParams();
    }
    if (cfg.emergencyExitTimeout == 0 || cfg.valuationTimeout == 0 || cfg.riskSignerDelay == 0) {
      revert VaultErrors.InvalidParams();
    }
    if (cfg.minDepositAssets == 0 || cfg.minRedeemShares == 0) revert VaultErrors.InvalidParams();
  }

  /// @dev Bound stored timestamps and leave a valuation window before permissionless emergency exit.
  function _validateTiming(VaultTypes.VaultConfig memory cfg) private pure {
    _requireSafeDuration(cfg.depositEpochDuration);
    _requireSafeDuration(cfg.redemptionEpochDuration);
    _requireSafeDuration(cfg.redemptionCloseCooldown);
    _requireSafeDuration(cfg.emergencyExitTimeout);
    _requireSafeDuration(cfg.valuationTimeout);
    _requireSafeDuration(cfg.riskSignerDelay);
    if (cfg.emergencyExitTimeout <= cfg.valuationTimeout) revert VaultErrors.InvalidParams();
  }

  /// @notice One fee checkpoint's inputs. A zero `priceWad` skips the performance leg.
  struct Checkpoint {
    uint256 supply;
    uint256 elapsed;
    uint256 freeSettlement;
    uint256 freeCorridor;
    uint256 priceWad;
    uint256 managementFeeWad;
    uint256 performanceFeeWad;
  }

  /// @notice Calculate management and performance shares, then split each fee with the protocol.
  /// @dev Updates fee marks in vault storage; the caller mints the returned shares.
  function checkpointAccrual(VaultTypes.Marks storage marks, Checkpoint memory c)
    external
    returns (uint256 operatorShares, uint256 protocolShares, address protocolRecipient)
  {
    // Performance is charged net of the management leg.
    uint256 managementShares = VaultLib.feeShares(c.supply, c.managementFeeWad, c.elapsed);
    uint256 performanceShares;
    if (c.supply == 0) {
      // Empty supply resets the basket to zero and the absolute mark to one WAD.
      _storeMarks(marks, true, 0, 0, 0, VaultLib.WAD);
    } else if (c.priceWad != 0) {
      performanceShares = _performanceLeg(marks, c, c.supply + managementShares);
    }
    if (managementShares + performanceShares == 0) return (0, 0, address(0));
    uint256 protocolManagementShareWad;
    uint256 protocolPerformanceShareWad;
    (protocolRecipient, protocolManagementShareWad, protocolPerformanceShareWad) =
      _factory().protocolFeeFor(address(this));
    (uint256 operatorManagementShares, uint256 protocolManagementShares) =
      VaultLib.splitFee(managementShares, protocolManagementShareWad);
    (uint256 operatorPerformanceShares, uint256 protocolPerformanceShares) =
      VaultLib.splitFee(performanceShares, protocolPerformanceShareWad);
    operatorShares = operatorManagementShares + operatorPerformanceShares;
    protocolShares = protocolManagementShares + protocolPerformanceShares;
  }

  /// @dev Charges NAV over the revalued basket, capped at NAV over the absolute mark when the
  ///      floor is on. `supplyAfterManagement` includes the management-fee shares.
  function _performanceLeg(
    VaultTypes.Marks storage marks,
    Checkpoint memory checkpoint,
    uint256 supplyAfterManagement
  ) private returns (uint256 performanceShares) {
    // A fresh basket is the inventory itself, so the first priced checkpoint charges nothing.
    bool fresh = marks.settlementWad == 0 && marks.corridorWad == 0;
    (uint256 basketSettlement, uint256 basketCorridor) = fresh
      ? (checkpoint.freeSettlement, checkpoint.freeCorridor)
      : (
        VaultLib.perShareTotal(marks.settlementWad, supplyAfterManagement),
        VaultLib.perShareTotal(marks.corridorWad, supplyAfterManagement)
      );
    (uint8 settlementDecimals, uint8 corridorDecimals) =
      _decimals(checkpoint.freeCorridor != 0 || basketCorridor != 0);
    uint256 navNow = VaultLib.nav(
      checkpoint.freeSettlement, checkpoint.freeCorridor, checkpoint.priceWad, settlementDecimals, corridorDecimals
    );
    uint256 basketValue =
      VaultLib.nav(basketSettlement, basketCorridor, checkpoint.priceWad, settlementDecimals, corridorDecimals);
    uint256 markWad = marks.highWaterWad;
    uint256 floorValue = navNow > basketValue ? _floorValue(markWad, supplyAfterManagement) : 0;
    uint256 gain = VaultLib.chargeableGain(navNow, basketValue, floorValue);

    performanceShares =
      VaultLib.performanceFeeShares(navNow, supplyAfterManagement, gain, checkpoint.performanceFeeWad);
    uint256 supplyAfterFees = supplyAfterManagement + performanceShares;

    // When the absolute floor limits the fee, only chargeable gain enters the settlement
    // basket; the rest remains eligible for a later fee. Otherwise use current inventory.
    // An existing basket is stored only when performance shares are nonzero.
    if (floorValue > basketValue) basketSettlement += gain;
    else (basketSettlement, basketCorridor) = (checkpoint.freeSettlement, checkpoint.freeCorridor);
    _storeMarks(
      marks,
      fresh || performanceShares != 0,
      basketSettlement,
      basketCorridor,
      supplyAfterFees,
      VaultLib.markAfter(navNow, supplyAfterFees, markWad)
    );
  }

  /// @notice Add deposited assets to the matching basket component and spread it over the new supply.
  /// @dev Uses atomic asset units before per-share rounding, preserving deferred gains for existing shares.
  ///      Reverts unless the epoch minted one share per minimum request of `assets`. Every
  ///      request is at least that minimum, so no request's floored claim rounds to zero.
  /// @param supply Supply before `shares` were minted.
  /// @param attestedS Settlement floor the checkpoint that just ran priced.
  /// @param attestedC Corridor floor the checkpoint that just ran priced.
  function absorbDeposit(
    VaultTypes.Marks storage marks,
    uint256 supply,
    uint256 shares,
    uint256 assets,
    bool inCorridor,
    uint256 attestedS,
    uint256 attestedC
  ) external {
    IOperatorVault self = IOperatorVault(address(this));
    uint256 minDeposit = inCorridor ? self.minDepositCorridor() : self.minDepositAssets();
    if (shares < Math.ceilDiv(assets, minDeposit)) revert VaultErrors.ZeroAmount();
    // Initialize from attested balances so surplus received after signing remains
    // eligible for a performance fee at a later checkpoint.
    bool fresh = marks.settlementWad == 0 && marks.corridorWad == 0;
    uint256 basketSettlement = fresh ? attestedS : VaultLib.perShareTotal(marks.settlementWad, supply);
    uint256 basketCorridor = fresh ? attestedC : VaultLib.perShareTotal(marks.corridorWad, supply);
    if (inCorridor) basketCorridor += assets;
    else basketSettlement += assets;
    _storeMarks(marks, true, basketSettlement, basketCorridor, supply + shares, marks.highWaterWad);
  }

  /// @dev When `rebase` is true, store both asset quantities per share, rounding up.
  ///      Always update the absolute mark and emit all three values if any mark changes.
  function _storeMarks(
    VaultTypes.Marks storage marks,
    bool rebase,
    uint256 settlementUnits,
    uint256 corridorUnits,
    uint256 supply,
    uint256 newMarkWad
  ) private {
    (uint256 settlementMark, uint256 corridorMark) = (marks.settlementWad, marks.corridorWad);
    bool changed = newMarkWad != marks.highWaterWad;
    if (changed) marks.highWaterWad = newMarkWad;
    if (rebase) {
      (uint256 nextSettlementMark, uint256 nextCorridorMark) =
        (VaultLib.basketPerShare(settlementUnits, supply), VaultLib.basketPerShare(corridorUnits, supply));
      if (nextSettlementMark != settlementMark || nextCorridorMark != corridorMark) {
        (marks.settlementWad, marks.corridorWad) = (nextSettlementMark, nextCorridorMark);
        (settlementMark, corridorMark) = (nextSettlementMark, nextCorridorMark);
        changed = true;
      }
    }
    if (changed) emit IOperatorVault.MarkUpdated(newMarkWad, settlementMark, corridorMark);
  }

  /// @dev Read vault immutables here to save bytecode at vault call sites. Decimals are
  ///      unnecessary when both current inventory and the fee basket contain no corridor asset.
  function _decimals(bool corridorHeld) private view returns (uint8, uint8) {
    if (!corridorHeld) return (0, 0);
    IOperatorVault self = IOperatorVault(address(this));
    return (self.settlementDecimals(), self.corridorDecimals());
  }

  /// @dev NAV the absolute mark stands for, or zero when the vault's floor is off.
  function _floorValue(uint256 markWad, uint256 supply) private view returns (uint256) {
    return IOperatorVault(address(this)).perfFloorEnabled() ? VaultLib.perShareTotal(markWad, supply) : 0;
  }

  /// @dev Under delegatecall `address(this)` is the vault. Read rather than passed in: an
  ///      immutable costs the vault 33 bytes per read site.
  function _factory() private view returns (IOperatorVaultFactory) {
    return IOperatorVaultFactory(IOperatorVault(address(this)).factory());
  }

  /// @notice Require the minimum redemption size, except for an owner's full nonzero balance.
  /// @dev The exception lets holders, including fee recipients, exit balances below the minimum.
  function validateRedeemRequest(
    uint256 shares,
    uint256 minRedeemShares,
    uint256 balance,
    address controller,
    address owner
  ) external pure {
    if (shares == 0 || (shares < minRedeemShares && shares != balance)) revert VaultErrors.BelowMinSize();
    if (controller == address(0) || owner == address(0)) revert VaultErrors.ZeroAddress();
  }

  /// @notice Bind a fresh adapter clone to the calling vault. Only the settlement asset is approved.
  /// @return yieldToken Token the adapter position is held in.
  function bindYieldAdapter(address adapter, IERC20 settlement) external returns (address yieldToken) {
    IYieldAdapter(adapter).initialize(address(this), address(settlement));
    settlement.forceApprove(adapter, type(uint256).max);
    return IYieldAdapter(adapter).yieldToken();
  }

  /// @notice Recall enough so at least `needed` is liquid. A shortfall of even 1 wei reverts.
  /// @param reserved Position already owed to emergency redeemers; a fill may not withdraw it.
  function prepareIdle(IYieldAdapter adapter, uint256 liquid, uint256 needed, uint256 reserved) external {
    if (liquid >= needed) return;
    if (address(adapter) == address(0)) revert VaultErrors.InsufficientSettlement();
    uint256 gap = needed - liquid;
    if (adapter.held() < reserved + gap) revert VaultErrors.InsufficientSettlement();
    uint256 withdrawn = adapter.recall(gap);
    if (withdrawn < gap) revert VaultErrors.InsufficientSettlement();
    emit IOperatorVault.SettlementPrepared(needed, withdrawn);
  }

  /// @notice Supply idle settlement above the floor. No-op when `halted` (paused or close-only).
  function allocateIdle(IYieldAdapter adapter, uint256 liquid, uint256 minLiquid, bool halted) external {
    if (halted || liquid <= minLiquid) return;
    uint256 assets = liquid - minLiquid;
    adapter.deploy(assets);
    emit IOperatorVault.IdleAllocated(assets);
  }

  /// @notice Recall the adapter position down to `reserved`.
  /// @param reserved Position already owed to emergency redeemers; withdrawing it would turn
  ///        their in-kind claim into vault settlement they can no longer reach.
  function recallAllIdle(IYieldAdapter adapter, uint256 reserved) external {
    uint256 held = adapter.held();
    if (held <= reserved) return;
    emit IOperatorVault.IdleRecalled(adapter.recall(_recallAmount(held, reserved)));
  }

  /// @notice Attempt to recall the unreserved position for an emergency exit.
  /// @dev A recall revert leaves the position available for in-kind claims. Calls to
  ///      `held()` are outside the catch and must succeed.
  /// @return stranded Free underlying still held by the adapter afterwards.
  function tryRecallAllIdle(IYieldAdapter adapter, uint256 reserved) external returns (uint256 stranded) {
    if (address(adapter) == address(0)) return 0;
    uint256 held = adapter.held();
    if (held <= reserved) return 0;
    try adapter.recall(_recallAmount(held, reserved)) returns (uint256 withdrawn) {
      emit IOperatorVault.IdleRecalled(withdrawn);
      // A reverted recall moves nothing, so `held` is only re-read on success.
      held = adapter.held();
    } catch {} // solhint-disable-line no-empty-blocks
    return held > reserved ? held - reserved : 0;
  }

  /// @dev `max` takes Aave's own full-balance path (no index dust) when nothing is reserved.
  function _recallAmount(uint256 held, uint256 reserved) private pure returns (uint256) {
    return reserved == 0 ? type(uint256).max : held - reserved;
  }

  /// @notice Attempt to move yield tokens reserved for emergency claims into the vault.
  /// @dev Returns false when `transferHeld` reverts. A successful transfer may be clamped
  ///      to the adapter's balance; claimants share the yield tokens actually received.
  /// @return synced True if the adapter call succeeds, allowing the pending reserve to clear.
  function syncPendingYield(IYieldAdapter adapter, uint256 owed) external returns (bool synced) {
    try adapter.transferHeld(address(this), owed) returns (uint256 sent) {
      emit IOperatorVault.YieldPullSynced(sent);
      return true;
    } catch {
      return false;
    }
  }

  /// @notice Pay one claimant's share of the in-kind yield leg; the last claimant gets the residue.
  function payYield(
    address yieldToken,
    address controller,
    address receiver,
    uint256 epochId,
    uint256 weight,
    uint256 outstanding
  ) external {
    uint256 yieldOut =
      VaultLib.proRataWithResidue(weight, outstanding, IERC20(yieldToken).balanceOf(address(this)));
    if (yieldOut == 0) return;
    IERC20(yieldToken).safeTransfer(receiver, yieldOut);
    emit IOperatorVault.ClaimedYield(controller, receiver, epochId, yieldOut);
  }

  /// @notice Check order identity, limits, inventory, and preferred fillers.
  /// @dev Malformed validation data can revert during ABI decoding.
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
    // Permit2 authorizes the exact input amount; variable-input orders are not supported.
    if (order.input.maxAmount != order.input.amount) return false;

    address inputToken = address(order.input.token);
    bool sellSettlement = inputToken == ctx.settlementAsset && output.token == ctx.corridorAsset;
    bool sellCorridor = inputToken == ctx.corridorAsset && output.token == ctx.settlementAsset;
    if (!sellSettlement && !sellCorridor) return false;

    uint256 cap = sellSettlement ? ctx.maxOrderInputSettlement : ctx.maxOrderInputCorridor;
    if (order.input.amount > cap) return false;

    uint256 available = sellSettlement ? ctx.quotableSettlement : ctx.quotableCorridor;
    if (order.input.amount > available) return false;
    if (ctx.closeOnly && !sellCorridor) return false;

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

  /// @notice Validate the Permit2 digest, order policy, and both EOA signer signatures.
  /// @dev Returns the ERC-1271 failure value for rejected orders or signatures; malformed
  ///      encodings and failed external reads can revert.
  function validateEnvelope(bytes32 hash, bytes calldata signature, address vault)
    external
    view
    returns (bytes4)
  {
    IOperatorVault src = IOperatorVault(vault);
    (LimitOrder memory order, bytes memory operatorSig, bytes memory riskSig) =
      abi.decode(signature, (LimitOrder, bytes, bytes));
    if (VaultLib.permit2Digest(order, src.permit2(), block.chainid) != hash) return VaultLib.ERC1271_FAIL;
    address settlement = address(src.settlementAsset());
    address corridor = address(src.corridorAsset());
    address inputToken = address(order.input.token);
    uint256 quotableS;
    uint256 quotableC;
    if (inputToken == settlement) {
      // Quoting prices economic inventory, but Permit2 can only pull what is liquid.
      // Held funds count once `prepareSettlement` has recalled them.
      quotableS = src.quotableSettlement();
      uint256 liquid = src.liquidSettlement();
      if (liquid < quotableS) quotableS = liquid;
    } else if (inputToken == corridor) {
      quotableC = src.quotableCorridor();
    }
    if (
      !_orderPolicyOk(
        order,
        OrderContext({
          reactor: src.reactor(),
          vault: vault,
          preferredFillerValidation: src.preferredFillerValidation(),
          tradingEpoch: src.tradingEpoch(),
          maxOrderLifetime: src.maxOrderLifetime(),
          settlementAsset: settlement,
          corridorAsset: corridor,
          maxOrderInputSettlement: src.maxOrderInputSettlement(),
          maxOrderInputCorridor: src.maxOrderInputCorridor(),
          quotableSettlement: quotableS,
          quotableCorridor: quotableC,
          closeOnly: src.closeOnly()
        })
      )
    ) return VaultLib.ERC1271_FAIL;
    if (!VaultLib.isSigner(src.strategySigner(), hash, operatorSig)) return VaultLib.ERC1271_FAIL;
    if (!VaultLib.isSigner(src.riskSigner(), hash, riskSig)) return VaultLib.ERC1271_FAIL;
    return IERC1271.isValidSignature.selector;
  }

  /*//////////////////////////////////////////////////////////////
              ADMIN LIFECYCLE (delegatecalled by the vault)
  //////////////////////////////////////////////////////////////*/

  /// @notice Replace the strategy signer while keeping it distinct from current and pending risk signers.
  function setStrategySigner(VaultTypes.Roles storage roles, address next, uint256 newTradingEpoch)
    external
  {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == roles.riskSigner || next == roles.pendingRiskSigner) revert VaultErrors.InvalidParams();
    address previous = roles.strategySigner;
    roles.strategySigner = next;
    emit IOperatorVault.StrategySignerRotated(previous, next, newTradingEpoch);
  }

  /// @notice Propose a risk signer for delayed activation, or cancel an existing proposal with zero.
  function proposeRiskSigner(VaultTypes.Roles storage roles, address next, uint256 delay) external {
    if (next == address(0)) {
      if (!_clearPendingRiskSigner(roles)) revert VaultErrors.InvalidParams();
      return;
    }
    if (next == roles.strategySigner) revert VaultErrors.InvalidParams();
    // `delay` passed `_requireSafeDuration`, so the sum fits uint96.
    uint96 applyAt = uint96(block.timestamp + delay);
    roles.pendingRiskSigner = next;
    roles.pendingRiskSignerAt = applyAt;
    emit IOperatorVault.RiskSignerProposed(next, applyAt);
  }

  /// @notice Activate the proposed risk signer once its delay has elapsed.
  /// @dev Anyone may trigger activation; the proposed signer must still differ from the strategy signer.
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

  /// @notice Propose an operator admin; authority changes only when that address accepts.
  ///         Zero cancels an existing proposal.
  function proposeOperatorAdmin(VaultTypes.Roles storage roles, address next) external {
    address pending = roles.pendingOperatorAdmin;
    _checkProposal(roles, next, pending);
    roles.pendingOperatorAdmin = next;
    if (next == address(0)) emit IOperatorVault.OperatorAdminProposalCancelled(pending);
    else emit IOperatorVault.OperatorAdminProposed(next);
  }

  /// @notice Accept the operator-admin role and update the factory index.
  /// @dev Under delegatecall, `msg.sender` is the proposed admin and the factory sees the vault as caller.
  function acceptOperatorAdmin(
    VaultTypes.Roles storage roles,
    address factory,
    address settlementAsset,
    address corridorAsset
  ) external {
    address next = _acceptable(roles, roles.pendingOperatorAdmin);
    roles.pendingOperatorAdmin = address(0);
    address previous = roles.operatorAdmin;
    roles.operatorAdmin = next;
    IOperatorVaultFactory(factory).rekeyOperator(previous, next, settlementAsset, corridorAsset);
    emit IOperatorVault.OperatorAdminTransferred(previous, next);
  }

  /// @notice Propose a risk admin; zero cancels an existing proposal.
  function proposeRiskAdmin(VaultTypes.Roles storage roles, address next) external {
    address pending = roles.pendingRiskAdmin;
    _checkProposal(roles, next, pending);
    roles.pendingRiskAdmin = next;
    if (next == address(0)) emit IOperatorVault.RiskAdminProposalCancelled(pending);
    else emit IOperatorVault.RiskAdminProposed(next);
  }

  /// @notice Accept the risk-admin role and cancel any pending risk-signer proposal.
  function acceptRiskAdmin(VaultTypes.Roles storage roles) external {
    address next = _acceptable(roles, roles.pendingRiskAdmin);
    roles.pendingRiskAdmin = address(0);
    // A new risk admin must not inherit the outgoing admin's pending signer.
    _clearPendingRiskSigner(roles);
    emit IOperatorVault.RiskAdminTransferred(roles.riskAdmin, next);
    roles.riskAdmin = next;
  }

  /// @notice Replace the guardian with a nonzero address.
  function setGuardian(VaultTypes.Roles storage roles, address next) external {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    emit IOperatorVault.GuardianUpdated(roles.guardian, next);
    roles.guardian = next;
  }

  /// @notice Recover an unrelated ERC-20 balance from the vault. The caller enforces guardian access.
  function sweepToken(
    address token,
    address to,
    address settlementAsset,
    address corridorAsset,
    address yieldToken
  ) external {
    if (to == address(0)) revert VaultErrors.ZeroAddress();
    // Share tokens, pool assets, and yield tokens back claims and cannot be swept.
    if (
      token == address(this) || token == settlementAsset || token == corridorAsset || token == yieldToken
    ) revert VaultErrors.InvalidPair();
    uint256 amount = IERC20(token).balanceOf(address(this));
    if (amount == 0) revert VaultErrors.ZeroAmount();
    IERC20(token).safeTransfer(to, amount);
    emit IOperatorVault.TokenSwept(token, to, amount);
  }

  /// @notice Recover the vault's native-token balance. The caller enforces guardian access.
  function sweepETH(address payable to) external {
    if (to == address(0)) revert VaultErrors.ZeroAddress();
    if (to == address(this)) revert VaultErrors.InvalidParams();
    uint256 amount = address(this).balance;
    if (amount == 0) revert VaultErrors.ZeroAmount();
    Address.sendValue(to, amount);
    emit IOperatorVault.ETHSwept(to, amount);
  }

  /// @dev Zero withdraws the pending proposal (which must exist); anything else must keep
  ///      the two admin roles apart.
  function _checkProposal(VaultTypes.Roles storage roles, address next, address pending) private view {
    if (next == address(0)) {
      if (pending == address(0)) revert VaultErrors.InvalidParams();
    } else {
      _requireDistinctAdmins(roles, next);
    }
  }

  /// @dev Only the proposed key can accept. Separation is re-checked because the other
  ///      admin role may have changed since the proposal.
  function _acceptable(VaultTypes.Roles storage roles, address pending) private view returns (address) {
    if (msg.sender != pending) revert VaultErrors.NotAuthorized();
    _requireDistinctAdmins(roles, pending);
    return pending;
  }

  /// @dev Distinct admin addresses preserve separate authority to rotate the two signers.
  ///      This enforces address separation, not independent ownership of those addresses.
  function _requireDistinctAdmins(VaultTypes.Roles storage roles, address next) private view {
    if (next == roles.operatorAdmin || next == roles.riskAdmin) revert VaultErrors.InvalidParams();
  }

  function _clearPendingRiskSigner(VaultTypes.Roles storage roles) private returns (bool cleared) {
    address pending = roles.pendingRiskSigner;
    if (pending == address(0)) return false;
    roles.pendingRiskSigner = address(0);
    roles.pendingRiskSignerAt = 0;
    emit IOperatorVault.RiskSignerProposalCancelled(pending);
    return true;
  }

  /// @notice Dual-signed like an order: one key alone must not set the conversion figures.
  function verifyAttestation(
    VaultLib.NavAttestation calldata att,
    bytes calldata strategySignature,
    bytes calldata riskSignature,
    uint256 epochId,
    address vault
  ) external view returns (uint256 price) {
    if (att.vault != vault || att.chainId != block.chainid || att.epochId != epochId) {
      revert VaultErrors.InvalidAttestation();
    }
    if (block.timestamp < att.validAfter || block.timestamp > att.validUntil) revert VaultErrors.InvalidAttestation();
    _requireWithinEpochDeadline(epochId, vault);
    if (att.corridorAssetPrice == 0) revert VaultErrors.InvalidAttestation();
    bytes32 digest = VaultLib.attestationDigest(att, vault, block.chainid);
    IOperatorVault src = IOperatorVault(vault);
    if (
      !VaultLib.isSigner(src.strategySigner(), digest, strategySignature)
        || !VaultLib.isSigner(src.riskSigner(), digest, riskSignature)
    ) revert VaultErrors.InvalidAttestation();
    return att.corridorAssetPrice;
  }

  /// @dev Limit use to `closedAt + valuationTimeout` for deposits and
  ///      `closedAt + emergencyExitTimeout` for redemptions, even if `validUntil` is later.
  ///      The boundary second allows either attested settlement or permissionless recovery.
  ///      Both vault callers require a Closed epoch before verification.
  function _requireWithinEpochDeadline(uint256 epochId, address vault) private view {
    IVaultEpochClock clock = IVaultEpochClock(vault);
    (, bool isDeposit,,, uint64 closedAt,,,,,,,) = clock.epochs(epochId);
    uint256 lifetime = isDeposit ? clock.valuationTimeout() : clock.emergencyExitTimeout();
    if (block.timestamp > uint256(closedAt) + lifetime) revert VaultErrors.InvalidAttestation();
  }

  function _requireDecimals(address token) private view returns (uint8 d) {
    d = IERC20Metadata(token).decimals();
    if (d == 0 || d > MAX_TOKEN_DECIMALS) revert VaultErrors.InvalidDecimals();
  }

  function _requireSafeDuration(uint256 duration) private pure {
    if (duration > MAX_DURATION) revert VaultErrors.InvalidParams();
  }
}
