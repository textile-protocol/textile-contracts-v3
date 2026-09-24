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
 * @notice Stateless fill wrapper for vault orders whose input may sit in the yield adapter:
 *         calls `prepareSettlement`, executes as the UniswapX filler, and forwards the input
 *         and any leftover output to `msg.sender`. Successful fills forward both token balances;
 *         failed native refunds remain available to a later caller.
 * @dev The reactor sees this contract as the filler, so `fill()` re-imposes the order's
 *      preferred-filler binding itself; otherwise anyone could front-run the bound taker.
 */
contract VaultOrderExecutor is ReentrancyGuard {
  using SafeERC20 for IERC20;
  using LimitOrderLib for LimitOrder;

  IReactor public immutable reactor;
  IOperatorVaultFactory public immutable factory;

  /// @dev Cap gas forwarded to the caller's native-token receiver. Refund failure is tolerated.
  uint256 private constant REFUND_GAS = 50_000;

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

  /// @notice Fill a vault LimitOrder. The caller supplies the output token (approved to this
  ///         contract) and receives the input token.
  /// @param signedOrder abi-encoded LimitOrder plus the vault's ERC-1271 envelope.
  function fill(SignedOrder calldata signedOrder) external nonReentrant {
    LimitOrder memory order = abi.decode(signedOrder.order, (LimitOrder));
    address vault = order.info.swapper;
    if (!factory.isVault(vault)) revert VaultErrors.UnknownVault();
    if (address(order.info.reactor) != address(reactor)) revert VaultErrors.UnsupportedOrder();
    if (order.outputs.length != 1) revert VaultErrors.UnsupportedOrder();
    _assertCallerMayFill(order.info.additionalValidationData);

    IERC20 inputToken = IERC20(address(order.input.token));
    IERC20 outputToken = IERC20(order.outputs[0].token);
    uint256 outputAmount = order.outputs[0].amount;
    // The reactor's fee hook appends fee outputs it also pulls from the filler.
    uint256 totalOutput = outputAmount + _outputFee(order, signedOrder.sig);

    // Unstake before the Permit2 pull; only settlement can sit in the adapter.
    if (address(inputToken) == address(IOperatorVault(vault).settlementAsset())) {
      IOperatorVault(vault).prepareSettlement(order.input.amount);
    }

    outputToken.safeTransferFrom(msg.sender, address(this), totalOutput);
    outputToken.forceApprove(address(reactor), totalOutput);
    reactor.execute(signedOrder);
    outputToken.forceApprove(address(reactor), 0);

    uint256 inputBalance = inputToken.balanceOf(address(this));
    if (inputBalance > 0) inputToken.safeTransfer(msg.sender, inputBalance);
    uint256 outputBalance = outputToken.balanceOf(address(this));
    if (outputBalance > 0) outputToken.safeTransfer(msg.sender, outputBalance);

    // Best effort: an Aave-side supply failure must not revert a fill the reactor completed.
    try IOperatorVault(vault).allocateIdle() {} catch {}
    _forwardNative();

    emit ExecutorFill(
      vault, msg.sender, address(inputToken), order.input.amount, address(outputToken), outputAmount
    );
  }

  /// @dev Accepts the reactor's end-of-fill refund.
  receive() external payable {}

  /// @dev Ignore a failed native refund so a rejecting receiver does not undo the fill.
  ///      The retained balance is offered to the next caller.
  function _forwardNative() private {
    uint256 balance = address(this).balance;
    if (balance == 0) return;
    // solhint-disable-next-line avoid-low-level-calls
    (bool ok,) = msg.sender.call{ value: balance, gas: REFUND_GAS }("");
    ok; // best effort
  }

  /// @dev Same binding format as PreferredFillerValidation: abi.encode(address[], uint256).
  ///      `exclusiveUntil` is ignored because VaultPolicy pins it at or past the deadline.
  function _assertCallerMayFill(bytes memory validationData) private view {
    (address[] memory preferredFillers,) = abi.decode(validationData, (address[], uint256));
    uint256 count = preferredFillers.length;
    for (uint256 i = 0; i < count; ++i) {
      if (preferredFillers[i] == msg.sender) return;
    }
    revert VaultErrors.CallerNotPreferredFiller();
  }

  /// @dev Mirrors `ProtocolFees._injectFees`. Fees in any other token are not fundable here.
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
