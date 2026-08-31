// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
// This smart contract is part of the Textile Protocol (Settlement v3).
pragma solidity 0.8.30;

import { IProtocolFeeController } from "./vendor/uniswapx/interfaces/IProtocolFeeController.sol";
import { OutputToken, ResolvedOrder } from "./vendor/uniswapx/base/ReactorStructs.sol";

/**
 * @title SellFirstFeeController
 * @notice UniswapX protocol-fee controller for the filler network's sell-first
 *         flow. The vendored reactor appends this fee output natively during
 *         order preparation and enforces its 5 bps maximum.
 * @dev The fee rate is set per deployment via the constructor (bounded by
 *      MAX_FEE_BPS) so each chain's controller matches its off-chain mirror
 *      (sellFirstNativeFeeBps in the constants package). e.g. 1 bps on BSC,
 *      5 bps on Base/Celo/Ethereum.
 */
contract SellFirstFeeController is IProtocolFeeController {
  /// @notice Hard cap the vendored reactor's ProtocolFees hook enforces.
  uint256 public constant MAX_FEE_BPS = 5;
  /// @notice Native fee in bps, fixed at deployment.
  uint256 public immutable FEE_BPS;
  uint256 private constant BPS = 10_000;

  address public immutable feeRecipient;

  error ZeroAddress();
  error InvalidFeeBps(uint256 feeBps);
  error FeeRoundsToZero(address token, uint256 amount);

  constructor(address feeRecipient_, uint256 feeBps_) {
    if (feeRecipient_ == address(0)) revert ZeroAddress();
    if (feeBps_ == 0 || feeBps_ > MAX_FEE_BPS) revert InvalidFeeBps(feeBps_);
    feeRecipient = feeRecipient_;
    FEE_BPS = feeBps_;
  }

  /// @inheritdoc IProtocolFeeController
  function getFeeOutputs(ResolvedOrder memory order) external view returns (OutputToken[] memory feeOutputs) {
    feeOutputs = new OutputToken[](order.outputs.length);
    uint256 tokenCount;

    for (uint256 i = 0; i < order.outputs.length; ++i) {
      OutputToken memory output = order.outputs[i];

      bool merged;
      for (uint256 j = 0; j < tokenCount; ++j) {
        if (feeOutputs[j].token == output.token) {
          feeOutputs[j].amount += output.amount;
          merged = true;
          break;
        }
      }

      if (!merged) {
        feeOutputs[tokenCount++] = OutputToken({ token: output.token, amount: output.amount, recipient: feeRecipient });
      }
    }

    uint256 feeOutputsLength;
    for (uint256 i = 0; i < tokenCount; ++i) {
      OutputToken memory output = feeOutputs[i];
      uint256 fee = (output.amount * FEE_BPS) / BPS;
      if (fee == 0) revert FeeRoundsToZero(output.token, output.amount);
      feeOutputs[feeOutputsLength++] = OutputToken({ token: output.token, amount: fee, recipient: feeRecipient });
    }

    assembly {
      mstore(feeOutputs, feeOutputsLength)
    }
  }
}
