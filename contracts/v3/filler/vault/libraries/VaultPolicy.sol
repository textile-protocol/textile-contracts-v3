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

/// @notice Linked library holding the vault logic that does not fit under the 24kb cap:
///         order policy, config checks, fee accrual, admin lifecycle, sweeps, adapter plumbing.
///         Non-view functions run as delegatecalls, so the adapter always sees the vault as caller.
/// @dev Not a trust boundary: the linked address is part of the vault's identity and
///      `VaultVerificationBundle.test.ts` pins it.
library VaultPolicy {
  using SafeERC20 for IERC20;

  /// @notice Caps on the deploy-time fee immutables. House terms are 10% management.
  uint256 internal constant MAX_MANAGEMENT_FEE_WAD = 25e16;
  /// @notice Below 100% so `nav - feeAssets` in `performanceFeeShares` stays positive.
  uint256 internal constant MAX_PERFORMANCE_FEE_WAD = 50e16;
  uint8 internal constant MAX_TOKEN_DECIMALS = 18;
  /// @notice Epoch timestamps are uint64, so `now + duration` fits by construction.
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

  /// @return settlementDecimals_ The settlement asset's decimals.
  /// @return corridorDecimals_ The corridor asset's decimals.
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
    if (cfg.operatorAdmin == cfg.riskAdmin) revert VaultErrors.InvalidParams();
    if (
      cfg.maxOrderInputSettlement == 0 || cfg.maxOrderInputCorridor == 0 || cfg.maxOrderLifetime == 0
        || cfg.depositEpochDuration == 0 || cfg.redemptionEpochDuration == 0 || cfg.redemptionCloseCooldown == 0
        || cfg.emergencyExitTimeout == 0 || cfg.valuationTimeout == 0
        || cfg.riskSignerDelay == 0 || cfg.minDepositAssets == 0 || cfg.minRedeemShares == 0
    ) revert VaultErrors.InvalidParams();
    if (cfg.yieldAdapter == address(0) && cfg.minLiquidSettlement != 0) revert VaultErrors.InvalidParams();
    _requireSafeDuration(cfg.depositEpochDuration);
    _requireSafeDuration(cfg.redemptionEpochDuration);
    _requireSafeDuration(cfg.redemptionCloseCooldown);
    _requireSafeDuration(cfg.emergencyExitTimeout);
    _requireSafeDuration(cfg.valuationTimeout);
    _requireSafeDuration(cfg.riskSignerDelay);
    // Otherwise the permissionless exit pauses the vault before the operator can settle.
    if (cfg.emergencyExitTimeout <= cfg.valuationTimeout) revert VaultErrors.InvalidParams();
    if (cfg.managementFeeWad > MAX_MANAGEMENT_FEE_WAD || cfg.performanceFeeWad > MAX_PERFORMANCE_FEE_WAD) {
      revert VaultErrors.InvalidParams();
    }
    settlementDecimals_ = _requireDecimals(address(cfg.settlementAsset));
    corridorDecimals_ = _requireDecimals(address(cfg.corridorAsset));
  }

  /// @notice One fee checkpoint's inputs. A zero `priceWad` skips the performance leg.
  struct Checkpoint {
    uint256 supply;
    uint256 elapsed;
    uint256 freeSettlement;
    uint256 freeCorridor;
    uint256 priceWad;
    uint256 markWad;
    uint256 managementFeeWad;
    uint256 performanceFeeWad;
  }

  /// @notice Both fee legs for one checkpoint, each split with the protocol on its own terms.
  ///         Delegatecalled: writes the basket mark and logs it; the absolute mark is returned.
  function checkpointAccrual(VaultTypes.BasketMark storage basket, Checkpoint memory c)
    external
    returns (uint256 operatorShares, uint256 protocolShares, address protocolRecipient, uint256 newMarkWad)
  {
    // Performance is charged net of the management leg.
    uint256 mgmt = VaultLib.feeShares(c.supply, c.managementFeeWad, c.elapsed);
    uint256 perf;
    if (c.supply == 0) {
      // Empty: both marks reset.
      newMarkWad = VaultLib.WAD;
      _storeMarks(basket, true, 0, 0, 0, c.markWad, newMarkWad);
    } else if (c.priceWad == 0) {
      newMarkWad = c.markWad;
    } else {
      (perf, newMarkWad) = _performanceLeg(basket, c, c.supply + mgmt);
    }
    if (mgmt + perf == 0) return (0, 0, address(0), newMarkWad);
    uint256 mgmtShareWad;
    uint256 perfShareWad;
    (protocolRecipient, mgmtShareWad, perfShareWad) = _factory().protocolFeeFor(address(this));
    (uint256 mgmtOperator, uint256 mgmtProtocol) = VaultLib.splitFee(mgmt, mgmtShareWad);
    (uint256 perfOperator, uint256 perfProtocol) = VaultLib.splitFee(perf, perfShareWad);
    operatorShares = mgmtOperator + perfOperator;
    protocolShares = mgmtProtocol + perfProtocol;
  }

  /// @dev Charges NAV over the revalued basket, capped at NAV over the absolute mark when the
  ///      floor is on. `supply` is post-management.
  function _performanceLeg(VaultTypes.BasketMark storage basket, Checkpoint memory c, uint256 supply)
    private
    returns (uint256 perf, uint256 newMarkWad)
  {
    // A fresh basket is the inventory itself, so the first priced checkpoint charges nothing.
    bool fresh = basket.settlementWad == 0 && basket.corridorWad == 0;
    (uint256 basketS, uint256 basketC) = fresh
      ? (c.freeSettlement, c.freeCorridor)
      : (VaultLib.perShareTotal(basket.settlementWad, supply), VaultLib.perShareTotal(basket.corridorWad, supply));
    (uint8 sDec, uint8 cDec) = _decimals(c.freeCorridor != 0 || basketC != 0);
    uint256 navNow = VaultLib.nav(c.freeSettlement, c.freeCorridor, c.priceWad, sDec, cDec);
    uint256 basketValue = VaultLib.nav(basketS, basketC, c.priceWad, sDec, cDec);
    uint256 floorValue = navNow > basketValue ? _floorValue(c.markWad, supply) : 0;
    uint256 gain = VaultLib.chargeableGain(navNow, basketValue, floorValue);

    perf = VaultLib.performanceFeeShares(navNow, supply, gain, c.performanceFeeWad);
    uint256 supplyAfter = supply + perf;
    newMarkWad = VaultLib.markAfter(navNow, supplyAfter, c.markWad);

    // Charged in full, the basket becomes the inventory. Floored, the charged slice joins the
    // settlement leg and the rest stays owed. No mint, no move.
    if (floorValue > basketValue) basketS += gain;
    else (basketS, basketC) = (c.freeSettlement, c.freeCorridor);
    _storeMarks(basket, fresh || perf != 0, basketS, basketC, supplyAfter, c.markWad, newMarkWad);
  }

  /// @notice Fold a processed deposit into the basket leg it arrived in: the basket's value grows
  ///         by exactly the epoch's value, so the new shares carry none of the gain deferred before them.
  /// @param supply Supply before `shares` were minted.
  function absorbDeposit(
    VaultTypes.BasketMark storage basket,
    uint256 markWad,
    uint256 supply,
    uint256 shares,
    uint256 assets,
    bool inCorridor
  ) external {
    uint256 basketS;
    uint256 basketC;
    if (basket.settlementWad == 0 && basket.corridorWad == 0) {
      // A fresh basket takes the whole post-mint inventory.
      IOperatorVault self = IOperatorVault(address(this));
      (basketS, basketC) = (self.freeSettlement(), self.freeCorridor());
    } else {
      basketS = VaultLib.perShareTotal(basket.settlementWad, supply) + (inCorridor ? 0 : assets);
      basketC = VaultLib.perShareTotal(basket.corridorWad, supply) + (inCorridor ? assets : 0);
    }
    _storeMarks(basket, true, basketS, basketC, supply + shares, markWad, markWad);
  }

  /// @dev Stores `units` of each leg per share over `supply` when `rebase`, and logs all three
  ///      marks when any of them moved.
  function _storeMarks(
    VaultTypes.BasketMark storage basket,
    bool rebase,
    uint256 unitsS,
    uint256 unitsC,
    uint256 supply,
    uint256 markWad,
    uint256 newMarkWad
  ) private {
    (uint256 s, uint256 k) = (basket.settlementWad, basket.corridorWad);
    bool moved;
    if (rebase) {
      (uint256 nextS, uint256 nextK) =
        (VaultLib.basketPerShare(unitsS, supply), VaultLib.basketPerShare(unitsC, supply));
      moved = nextS != s || nextK != k;
      if (moved) (basket.settlementWad, basket.corridorWad) = (nextS, nextK);
      (s, k) = (nextS, nextK);
    }
    if (moved || newMarkWad != markWad) emit IOperatorVault.MarkUpdated(newMarkWad, s, k);
  }

  /// @dev Vault immutables, read back rather than passed (33 vault bytes per read site) and only
  ///      when a corridor leg exists, since `nav` ignores them otherwise.
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

  /// @notice Both fee recipients are exempt from the floor: their positions are dilution
  ///         residue and there is no other way out of the vault.
  function validateRedeemRequest(
    uint256 shares,
    uint256 minRedeemShares,
    address controller,
    address owner,
    address feeRecipient
  ) external view {
    if (
      shares == 0
        || (shares < minRedeemShares && owner != feeRecipient && owner != _factory().protocolFeeRecipient())
    ) revert VaultErrors.BelowMinSize();
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

  /// @notice Best-effort full recall for the emergency exit: a failed withdrawal is swallowed
  ///         and the position still stranded is reported back for in-kind distribution.
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

  /// @notice Best-effort pull of the deferred emergency slice. Never reverts.
  /// @return synced True when it crossed, so the vault can clear its reserve.
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
    // Fixed input only. Implied by the Permit2 digest too, but stated here on purpose.
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

  function setStrategySigner(VaultTypes.Roles storage roles, address next, uint256 newTradingEpoch)
    external
  {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    if (next == roles.riskSigner || next == roles.pendingRiskSigner) revert VaultErrors.InvalidParams();
    address previous = roles.strategySigner;
    roles.strategySigner = next;
    emit IOperatorVault.StrategySignerRotated(previous, next, newTradingEpoch);
  }

  /// @notice Zero withdraws the pending proposal, so an unwanted signer cannot be activated
  ///         by a third party once the delay elapses (audit L-03).
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

  /// @notice Two-step handover (audit L-01): nothing changes until the proposed key accepts.
  ///         Zero withdraws the proposal.
  function proposeOperatorAdmin(VaultTypes.Roles storage roles, address next) external {
    address pending = roles.pendingOperatorAdmin;
    _checkProposal(roles, next, pending);
    roles.pendingOperatorAdmin = next;
    if (next == address(0)) emit IOperatorVault.OperatorAdminProposalCancelled(pending);
    else emit IOperatorVault.OperatorAdminProposed(next);
  }

  /// @dev Delegatecalled: `msg.sender` is the accepting key and the factory rekey comes from the vault.
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

  /// @notice Same handover shape as `proposeOperatorAdmin`, zero-cancel included.
  function proposeRiskAdmin(VaultTypes.Roles storage roles, address next) external {
    address pending = roles.pendingRiskAdmin;
    _checkProposal(roles, next, pending);
    roles.pendingRiskAdmin = next;
    if (next == address(0)) emit IOperatorVault.RiskAdminProposalCancelled(pending);
    else emit IOperatorVault.RiskAdminProposed(next);
  }

  function acceptRiskAdmin(VaultTypes.Roles storage roles) external {
    address next = _acceptable(roles, roles.pendingRiskAdmin);
    roles.pendingRiskAdmin = address(0);
    // A new risk admin must not inherit the outgoing admin's pending signer.
    _clearPendingRiskSigner(roles);
    emit IOperatorVault.RiskAdminTransferred(roles.riskAdmin, next);
    roles.riskAdmin = next;
  }

  function setGuardian(VaultTypes.Roles storage roles, address next) external {
    if (next == address(0)) revert VaultErrors.ZeroAddress();
    emit IOperatorVault.GuardianUpdated(roles.guardian, next);
    roles.guardian = next;
  }

  /// @notice Guardian sweep of a non-working ERC-20. Delegatecalled, so the balance is the vault's.
  function sweepToken(
    address token,
    address to,
    address settlementAsset,
    address corridorAsset,
    address yieldToken
  ) external {
    if (to == address(0)) revert VaultErrors.ZeroAddress();
    // The yield token stays unsweepable (audit H-01). It is zero when yield is off, and
    // sweeping token(0) is nonsense either way.
    if (
      token == address(this) || token == settlementAsset || token == corridorAsset || token == yieldToken
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

  /// @dev One entity holding both admin roles could rotate both signers and collapse the
  ///      dual-signature model (audit L-01). `validateConfig` enforces the same at deploy.
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
    if (att.corridorAssetPrice == 0) revert VaultErrors.InvalidAttestation();
    bytes32 digest = VaultLib.attestationDigest(att, vault, block.chainid);
    IOperatorVault src = IOperatorVault(vault);
    if (
      !VaultLib.isSigner(src.strategySigner(), digest, strategySignature)
        || !VaultLib.isSigner(src.riskSigner(), digest, riskSignature)
    ) revert VaultErrors.InvalidAttestation();
    return att.corridorAssetPrice;
  }

  function _requireDecimals(address token) private view returns (uint8 d) {
    d = IERC20Metadata(token).decimals();
    if (d == 0 || d > MAX_TOKEN_DECIMALS) revert VaultErrors.InvalidDecimals();
  }

  function _requireSafeDuration(uint256 duration) private pure {
    if (duration > MAX_DURATION) revert VaultErrors.InvalidParams();
  }
}
