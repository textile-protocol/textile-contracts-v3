// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import { IReactor } from "../filler/vendor/uniswapx/interfaces/IReactor.sol";
import { IReactorCallback } from "../filler/vendor/uniswapx/interfaces/IReactorCallback.sol";
import { ResolvedOrder, SignedOrder } from "../filler/vendor/uniswapx/base/ReactorStructs.sol";
import { VaultErrors } from "../filler/vault/libraries/VaultErrors.sol";

interface IEmergencyTarget {
  function settleRedeemEmergencyInKind(uint256 epochId) external;
}

/// @notice A preferred filler that calls the emergency exit from inside the reactor callback,
///         after the vault's input has been pulled and before the output is delivered.
contract EmergencyFillReentryProbe is IReactorCallback {
  IReactor public immutable reactor;
  IEmergencyTarget public immutable vault;
  uint256 public vaultInputSeen;

  constructor(address reactor_, address vault_) {
    reactor = IReactor(reactor_);
    vault = IEmergencyTarget(vault_);
  }

  function fill(SignedOrder calldata order, uint256 epochId) external {
    reactor.executeWithCallback(order, abi.encode(epochId));
  }

  function reactorCallback(ResolvedOrder[] memory orders, bytes memory data) external override {
    if (msg.sender != address(reactor)) revert VaultErrors.NotAuthorized();
    vaultInputSeen = IERC20(address(orders[0].input.token)).balanceOf(address(vault));
    vault.settleRedeemEmergencyInKind(abi.decode(data, (uint256)));
    IERC20(orders[0].outputs[0].token).approve(address(reactor), orders[0].outputs[0].amount);
  }
}
