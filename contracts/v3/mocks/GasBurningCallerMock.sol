// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

/// @dev A contract caller whose receive() burns every unit of gas it is given:
///      the worst case for a best-effort native transfer back to it.
contract GasBurningCallerMock {
  receive() external payable {
    assembly {
      invalid()
    }
  }

  function exec(address target, bytes calldata data) external {
    (bool ok, bytes memory ret) = target.call(data);
    if (!ok) {
      assembly {
        revert(add(ret, 32), mload(ret))
      }
    }
  }
}
