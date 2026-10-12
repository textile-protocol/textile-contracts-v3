// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { SafeERC20 } from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import { SignedOrder } from "../filler/vendor/uniswapx/base/ReactorStructs.sol";
import { IReactor } from "../filler/vendor/uniswapx/interfaces/IReactor.sol";

interface IVaultOrderExecutorFill {
  function fill(SignedOrder calldata signedOrder) external;
}

/**
 * @title AggregatorRouterMock
 * @notice Test-only stand-in for a DEX aggregator router that routes a user's swap
 *         through a Textile RFQ fill with itself as the taker.
 * @dev One tx: pull `sellAmount` of `sellToken` from the caller (who approved this router),
 *      approve the fill target for exactly that amount, fill, revoke the approval, forward
 *      every unit of `buyToken` received to `recipient` (reverting below `minOut`), and
 *      return any unspent `sellToken` to the caller. The order's preferred-filler list must
 *      name this router, because the reactor (or executor) sees it as msg.sender.
 */
contract AggregatorRouterMock {
  using SafeERC20 for IERC20;

  error InsufficientOutput(uint256 received, uint256 minOut);

  /// @notice Route through `reactor.executeBatch`. Spender is the reactor.
  function swapViaReactor(
    IReactor reactor,
    SignedOrder[] calldata orders,
    IERC20 sellToken,
    uint256 sellAmount,
    IERC20 buyToken,
    uint256 minOut,
    address recipient
  ) external returns (uint256 received) {
    uint256 buyBefore = _pullAndApprove(sellToken, sellAmount, buyToken, address(reactor));
    reactor.executeBatch(orders);
    received = _settle(sellToken, buyToken, buyBefore, address(reactor), minOut, recipient);
  }

  /// @notice Route a single vault order through `VaultOrderExecutor.fill`. Spender is the executor.
  function swapViaExecutor(
    IVaultOrderExecutorFill executor,
    SignedOrder calldata order,
    IERC20 sellToken,
    uint256 sellAmount,
    IERC20 buyToken,
    uint256 minOut,
    address recipient
  ) external returns (uint256 received) {
    uint256 buyBefore = _pullAndApprove(sellToken, sellAmount, buyToken, address(executor));
    executor.fill(order);
    received = _settle(sellToken, buyToken, buyBefore, address(executor), minOut, recipient);
  }

  function _pullAndApprove(IERC20 sellToken, uint256 sellAmount, IERC20 buyToken, address spender)
    private
    returns (uint256 buyBefore)
  {
    buyBefore = buyToken.balanceOf(address(this));
    sellToken.safeTransferFrom(msg.sender, address(this), sellAmount);
    sellToken.forceApprove(spender, sellAmount);
  }

  function _settle(
    IERC20 sellToken,
    IERC20 buyToken,
    uint256 buyBefore,
    address spender,
    uint256 minOut,
    address recipient
  ) private returns (uint256 received) {
    sellToken.forceApprove(spender, 0);
    received = buyToken.balanceOf(address(this)) - buyBefore;
    if (received < minOut) revert InsufficientOutput(received, minOut);
    buyToken.safeTransfer(recipient, received);
    uint256 leftover = sellToken.balanceOf(address(this));
    if (leftover > 0) sellToken.safeTransfer(msg.sender, leftover);
  }
}
