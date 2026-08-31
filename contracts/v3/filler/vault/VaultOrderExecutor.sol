// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import { ReentrancyGuard } from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import { OutputToken, ResolvedOrder, SignedOrder } from "../vendor/uniswapx/base/ReactorStructs.sol";
import { IProtocolFeeController } from "../vendor/uniswapx/interfaces/IProtocolFeeController.sol";
import { IReactor } from "../vendor/uniswapx/interfaces/IReactor.sol";
import { LimitOrder, LimitOrderLib } from "../vendor/uniswapx/lib/LimitOrderLib.sol";

import { IOperatorVault } from "./interfaces/IOperatorVault.sol";
import { IOperatorVaultFactory } from "./interfaces/IOperatorVaultFactory.sol";
import { VaultErrors } from "./libraries/VaultErrors.sol";

interface IFeeControllerSource {
  function feeController() external view returns (IProtocolFeeController);
}

/**
 * @title VaultOrderExecutor
 * @notice Stateless fill wrapper for vault orders whose input may sit in the
 *         yield adapter. UniswapX pulls the input via Permit2 before any
 *         callback, so the unstake has to happen before `reactor.execute` —
 *         this contract calls `prepareSettlement`, then executes as the
 *         UniswapX filler: it receives the input and pays the output, both of
 *         which are forwarded to `msg.sender` in the same transaction. It
 *         never holds tokens across transactions.
 * @dev Exclusivity caveat, by design: `PreferredFillerValidation` sees this
 *      contract as the filler, so listing it as a preferred filler makes the
 *      exclusive window public — any caller of `fill()` passes the check,
 *      receives the Permit2 input, and pays the signed output to the vault.
 *      The vault's economics are unaffected, but preferred-filler settler
 *      exclusivity does not apply to vault orders that name this executor.
 *      Only list it on orders where open filling is acceptable.
 */
contract VaultOrderExecutor is ReentrancyGuard {
  using SafeERC20 for IERC20;
  using LimitOrderLib for LimitOrder;

  IReactor public immutable reactor;
  IOperatorVaultFactory public immutable factory;

  event ExecutorFill(
    address indexed vault,
    address indexed filler,
    address inputToken,
    uint256 inputAmount,
    address outputToken,
    uint256 outputAmount
  );

  constructor(IReactor reactor_, IOperatorVaultFactory factory_) {
    if (address(reactor_) == address(0) || address(factory_) == address(0)) {
      revert VaultErrors.ZeroAddress();
    }
    reactor = reactor_;
    factory = factory_;
  }

  /// @notice Fill a vault LimitOrder. The caller supplies the output token
  ///         (approved to this contract) and receives the input token.
  ///         Deliberately permissionless — see the exclusivity caveat above.
  /// @param signedOrder abi-encoded LimitOrder plus the vault's ERC-1271 envelope.
  function fill(SignedOrder calldata signedOrder) external nonReentrant {
    LimitOrder memory order = abi.decode(signedOrder.order, (LimitOrder));
    address vault = order.info.swapper;
    if (!factory.isVault(vault)) revert VaultErrors.UnknownVault();
    if (address(order.info.reactor) != address(reactor)) revert VaultErrors.UnsupportedOrder();
    // Vault policy signs exactly one output; anything else is not a vault order.
    if (order.outputs.length != 1) revert VaultErrors.UnsupportedOrder();

    IERC20 inputToken = IERC20(address(order.input.token));
    IERC20 outputToken = IERC20(order.outputs[0].token);
    uint256 outputAmount = order.outputs[0].amount;
    // The reactor's fee hook appends fee outputs it also pulls from the
    // filler, so the caller funds the order output plus the fee.
    uint256 totalOutput = outputAmount + _outputFee(order, signedOrder.sig);

    // Unstake before the Permit2 pull; only settlement can sit in the adapter.
    if (address(inputToken) == address(IOperatorVault(vault).settlementAsset())) {
      IOperatorVault(vault).prepareSettlement(order.input.amount);
    }

    outputToken.safeTransferFrom(msg.sender, address(this), totalOutput);
    outputToken.forceApprove(address(reactor), totalOutput);
    reactor.execute(signedOrder);
    outputToken.forceApprove(address(reactor), 0);

    // Forward the received input and any output leftover — this contract must
    // end the transaction holding nothing.
    uint256 inputBalance = inputToken.balanceOf(address(this));
    if (inputBalance > 0) inputToken.safeTransfer(msg.sender, inputBalance);
    uint256 outputBalance = outputToken.balanceOf(address(this));
    if (outputBalance > 0) outputToken.safeTransfer(msg.sender, outputBalance);

    // Restake whatever is idle again; no-op when paused or close-only, and
    // best-effort by design — an Aave-side supply failure (frozen reserve,
    // supply cap) must not revert a fill the reactor already completed. Idle
    // just stays liquid until a later allocateIdle succeeds.
    try IOperatorVault(vault).allocateIdle() {} catch {}

    emit ExecutorFill(
      vault, msg.sender, address(inputToken), order.input.amount, address(outputToken), outputAmount
    );
  }

  /// @dev Mirrors `ProtocolFees._injectFees`: ask the reactor's fee controller
  ///      for the fee outputs it will append to this exact resolved order and
  ///      sum the ones in the order's output token. Fees in any other token
  ///      are not fundable by this wrapper, so such orders are rejected.
  function _outputFee(LimitOrder memory order, bytes calldata sig) private view returns (uint256 fee) {
    IProtocolFeeController controller = IFeeControllerSource(address(reactor)).feeController();
    if (address(controller) == address(0)) return 0;
    OutputToken[] memory feeOutputs = controller.getFeeOutputs(
      ResolvedOrder({ info: order.info, input: order.input, outputs: order.outputs, sig: sig, hash: order.hash() })
    );
    address outputTokenAddress = order.outputs[0].token;
    for (uint256 i = 0; i < feeOutputs.length; ++i) {
      if (feeOutputs[i].token != outputTokenAddress) revert VaultErrors.UnsupportedOrder();
      fee += feeOutputs[i].amount;
    }
  }
}
