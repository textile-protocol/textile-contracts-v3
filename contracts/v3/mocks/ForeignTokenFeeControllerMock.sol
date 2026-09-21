// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { OutputToken, ResolvedOrder } from "../filler/vendor/uniswapx/base/ReactorStructs.sol";
import { IProtocolFeeController } from "../filler/vendor/uniswapx/interfaces/IProtocolFeeController.sol";

/// @notice Fee controller that bills in a token the order does not pay out.
contract ForeignTokenFeeControllerMock is IProtocolFeeController {
  address public immutable feeToken;
  address public immutable recipient;
  uint256 public immutable amount;

  constructor(address feeToken_, address recipient_, uint256 amount_) {
    feeToken = feeToken_;
    recipient = recipient_;
    amount = amount_;
  }

  function getFeeOutputs(ResolvedOrder memory) external view returns (OutputToken[] memory fees) {
    fees = new OutputToken[](1);
    fees[0] = OutputToken({ token: feeToken, amount: amount, recipient: recipient });
  }
}
