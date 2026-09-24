// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { VaultTypes } from "../libraries/VaultTypes.sol";

interface IOperatorVaultFactory {
  /// @notice Deploy a vault for `msg.sender == init.operatorAdmin`. `init.name` and
  ///         `init.symbol` are 1 to 64 and 1 to 16 bytes respectively.
  function deployVault(VaultTypes.VaultInit calldata init) external returns (address vault);

  function isVault(address vault) external view returns (bool);

  /// @notice Where Textile's cut of every vault's fee accruals is minted. Immutable.
  function protocolFeeRecipient() external view returns (address);
  /// @notice The recipient plus `vault`'s own cut of each fee leg (WAD), fixed at deploy.
  function protocolFeeFor(address vault)
    external
    view
    returns (address recipient, uint256 managementShareWad, uint256 performanceShareWad);

  /// @notice The most recently indexed vault for the tuple, or zero. Use `vaultsOf` for all of them.
  function vaultOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address);

  /// @notice Every vault indexed to this operator and pair, in insertion order.
  /// @dev Admin handovers append the transferred vault to the destination index.
  function vaultsOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (address[] memory);

  function vaultCountOf(address operatorAdmin, address settlementAsset, address corridorAsset)
    external
    view
    returns (uint256);

  /// @notice Move the calling vault from one operator's index to another's. Vaults only.
  function rekeyOperator(
    address fromAdmin,
    address toAdmin,
    address settlementAsset,
    address corridorAsset
  ) external;
}
