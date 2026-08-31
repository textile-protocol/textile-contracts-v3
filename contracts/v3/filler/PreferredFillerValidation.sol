// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
// This smart contract is part of the Textile Protocol (Settlement v3).
pragma solidity 0.8.30;

import { ResolvedOrder } from "./vendor/uniswapx/base/ReactorStructs.sol";
import { IValidationCallback } from "./vendor/uniswapx/interfaces/IValidationCallback.sol";

import { FillerConstants } from "./FillerConstants.sol";

/**
 * @title PreferredFillerValidation
 * @notice Gives a bounded set of filler wallets exclusive access to an order
 *         until a signed deadline, then permits every filler.
 * @dev Validation data is abi.encode(address[] preferredFillers,
 *      uint256 exclusiveUntil). The callback is stateless; both values are
 *      already covered by the maker's Permit2 witness signature.
 */
contract PreferredFillerValidation is IValidationCallback {
  uint256 public constant MAX_PREFERRED_FILLERS = FillerConstants.MAX_PREFERRED_FILLERS;

  error InvalidCaller(address caller);
  error InvalidPreferredFillerCount(uint256 count);
  error ZeroPreferredFiller();
  error FillerNotPreferred(address filler, uint256 exclusiveUntil);

  /// @inheritdoc IValidationCallback
  function validate(address filler, ResolvedOrder calldata resolvedOrder) external view {
    if (msg.sender != address(resolvedOrder.info.reactor)) revert InvalidCaller(msg.sender);

    (address[] memory preferredFillers, uint256 exclusiveUntil) =
      abi.decode(resolvedOrder.info.additionalValidationData, (address[], uint256));

    uint256 count = preferredFillers.length;
    if (count == 0 || count > MAX_PREFERRED_FILLERS) revert InvalidPreferredFillerCount(count);
    if (block.timestamp > exclusiveUntil) return;

    for (uint256 i = 0; i < count; ++i) {
      address preferredFiller = preferredFillers[i];
      if (preferredFiller == address(0)) revert ZeroPreferredFiller();
      if (preferredFiller == filler) return;
    }
    revert FillerNotPreferred(filler, exclusiveUntil);
  }
}
