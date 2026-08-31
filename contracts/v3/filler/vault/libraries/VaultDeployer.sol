// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { OperatorVault } from "../OperatorVault.sol";
import { VaultTypes } from "./VaultTypes.sol";

/// @notice Linked library that carries the OperatorVault creation bytecode so
///         the factory runtime stays under the 24kb cap. Runs as a delegatecall
///         from the factory: the vault is created from the factory address and
///         sees the factory as `msg.sender`, exactly as a direct `new` would.
library VaultDeployer {
  function deploy(VaultTypes.VaultConfig memory cfg) external returns (address) {
    return address(new OperatorVault(cfg));
  }
}
