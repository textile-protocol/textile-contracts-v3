// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { OperatorVault } from "../OperatorVault.sol";
import { VaultTypes } from "./VaultTypes.sol";

/// @notice Linked library carrying the OperatorVault creation code so the factory stays under
///         the 24kb cap. Delegatecalled, so the vault sees the factory as `msg.sender`.
library VaultDeployer {
  /// @notice Deploy a vault with the supplied configuration and share-token labels.
  function deploy(VaultTypes.VaultConfig calldata cfg, string calldata name, string calldata symbol)
    external
    returns (address)
  {
    return address(new OperatorVault(cfg, name, symbol));
  }
}
