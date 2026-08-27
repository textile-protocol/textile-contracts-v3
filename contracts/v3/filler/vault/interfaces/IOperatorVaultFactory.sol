// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { VaultTypes } from "../libraries/VaultTypes.sol";

interface IOperatorVaultFactory {
  function deployVault(VaultTypes.VaultInit calldata init) external returns (address vault);

  function isVault(address vault) external view returns (bool);

  function vaultOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address);

  function rekeyOperator(
    address fromAdmin,
    address toAdmin,
    address settlementAsset,
    address corridorAsset
  ) external;
}
