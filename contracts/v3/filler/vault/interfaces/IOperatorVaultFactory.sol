// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { VaultTypes } from "../libraries/VaultTypes.sol";

interface IOperatorVaultFactory {
  /// @notice Deploy a vault for `msg.sender == init.operatorAdmin`. `init.name`
  ///         and `init.symbol` become the share token's ERC-20 strings: 1 to
  ///         64 and 1 to 16 bytes respectively, or the deploy reverts.
  function deployVault(VaultTypes.VaultInit calldata init) external returns (address vault);

  function isVault(address vault) external view returns (bool);

  /// @notice Protocol cut of every fee accrual, management and performance
  ///         alike, in every vault this factory deploys: where it is minted, and the WAD fraction of the
  ///         accrual it takes. Immutable — a new cut means a new factory.
  function protocolFeeRecipient() external view returns (address);
  function protocolFeeShareWad() external view returns (uint256);
  /// @notice Both of the above in one read; what the vaults call at checkpoint.
  function protocolFee() external view returns (address recipient, uint256 shareWad);

  /// @notice The most recently indexed vault for the tuple, or zero when the
  ///         operator has none. An operator may hold several — this is the
  ///         one a caller recovering a lost deploy receipt is looking for.
  ///         Use `vaultsOf` when you need all of them.
  function vaultOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address);

  /// @notice Every vault the operator holds for the pair, oldest first.
  function vaultsOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address[] memory);

  /// @notice How many vaults the operator holds for the pair.
  function vaultCountOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (uint256);

  function rekeyOperator(
    address fromAdmin,
    address toAdmin,
    address settlementAsset,
    address corridorAsset
  ) external;
}
