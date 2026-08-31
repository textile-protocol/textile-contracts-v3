// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC1271 } from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import { IERC20Metadata } from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { LimitOrder } from "../../vendor/uniswapx/lib/LimitOrderLib.sol";
import { OutputToken } from "../../vendor/uniswapx/base/ReactorStructs.sol";

import { IOperatorVault } from "../interfaces/IOperatorVault.sol";
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
  function maxOrderInputSettlement() external view returns (uint256);
  function maxOrderInputCorridor() external view returns (uint256);
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
  /// @dev Must match `PreferredFillerValidation.MAX_PREFERRED_FILLERS`.
  uint256 internal constant MAX_PREFERRED_FILLERS = 10;

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

  function validateConfig(VaultTypes.VaultConfig memory cfg) external view {
    if (
      address(cfg.settlementAsset) == address(0) || address(cfg.corridorAsset) == address(0)
        || cfg.reactor == address(0) || cfg.permit2 == address(0) || cfg.preferredFillerValidation == address(0)
        || cfg.operatorAdmin == address(0) || cfg.strategySigner == address(0) || cfg.riskAdmin == address(0)
        || cfg.riskSigner == address(0) || cfg.guardian == address(0) || cfg.feeRecipient == address(0)
    ) revert VaultErrors.ZeroAddress();
    if (address(cfg.settlementAsset) == address(cfg.corridorAsset)) revert VaultErrors.InvalidPair();
    if (cfg.strategySigner == cfg.riskSigner) revert VaultErrors.InvalidParams();
    if (
      cfg.maxOrderInputSettlement == 0 || cfg.maxOrderInputCorridor == 0 || cfg.maxOrderLifetime == 0
        || cfg.depositEpochDuration == 0 || cfg.redemptionEpochDuration == 0 || cfg.redemptionCloseCooldown == 0
        || cfg.inKindExitTimeout == 0 || cfg.emergencyExitTimeout == 0 || cfg.valuationTimeout == 0
        || cfg.riskSignerDelay == 0 || cfg.minDepositAssets == 0 || cfg.minRedeemShares == 0 || cfg.version == 0
    ) revert VaultErrors.InvalidParams();
    if (cfg.emergencyExitTimeout <= cfg.inKindExitTimeout) revert VaultErrors.InvalidParams();
    if (cfg.yieldAdapter == address(0) && cfg.minLiquidSettlement != 0) revert VaultErrors.InvalidParams();
    _requireSafeDuration(cfg.depositEpochDuration);
    _requireSafeDuration(cfg.redemptionEpochDuration);
    _requireSafeDuration(cfg.redemptionCloseCooldown);
    _requireSafeDuration(cfg.inKindExitTimeout);
    _requireSafeDuration(cfg.emergencyExitTimeout);
    _requireSafeDuration(cfg.valuationTimeout);
    _requireSafeDuration(cfg.riskSignerDelay);
    if (cfg.managementFeeWad > MAX_MANAGEMENT_FEE_WAD) revert VaultErrors.InvalidParams();
    _requireDecimals(address(cfg.settlementAsset));
    _requireDecimals(address(cfg.corridorAsset));
  }

  /// @notice Bind a freshly cloned adapter to the calling vault and approve it
  ///         for the settlement asset only.
  function bindYieldAdapter(address adapter, IERC20 settlement) external {
    IYieldAdapter(adapter).initialize(address(this), address(settlement));
    settlement.forceApprove(adapter, type(uint256).max);
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
    if (count == 0 || count > MAX_PREFERRED_FILLERS || exclusiveUntil < order.info.deadline) {
      return false;
    }
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

  function _requireDecimals(address token) private view {
    uint8 d = IERC20Metadata(token).decimals();
    if (d == 0 || d > MAX_TOKEN_DECIMALS) revert VaultErrors.InvalidDecimals();
  }

  /// @dev Epoch timestamps are uint64. A duration that cannot be added to now
  ///      without overflowing that width bricks later close / timeout / rotation.
  function _requireSafeDuration(uint256 duration) private view {
    if (duration > type(uint64).max - block.timestamp) revert VaultErrors.InvalidParams();
  }
}
