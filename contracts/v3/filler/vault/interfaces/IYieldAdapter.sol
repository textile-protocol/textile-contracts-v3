// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

/**
 * @title IYieldAdapter
 * @notice Minimal idle-yield adapter surface for OperatorVault. One adapter
 *         instance per vault; the vault is the only caller of `deploy` and
 *         `recall`. The adapter custodies the yield position (e.g. aTokens),
 *         never the vault's working balance.
 */
interface IYieldAdapter {
  /// @notice Underlying asset the adapter accepts. The vault's settlement asset.
  function asset() external view returns (address);

  /// @notice Vault this adapter is bound to. Zero until `initialize`.
  function vault() external view returns (address);

  /// @notice Current position value in underlying units, interest included.
  function held() external view returns (uint256);

  /// @notice One-time binding, called by the vault from its constructor.
  /// @param vault_ Vault to bind. Must be the caller.
  /// @param asset_ Underlying asset to deploy.
  function initialize(address vault_, address asset_) external;

  /// @notice Pull `assets` from the vault and put them to work. Vault only.
  /// @param assets Underlying amount to deploy. Must be nonzero.
  function deploy(uint256 assets) external;

  /// @notice Withdraw `assets` back to the vault. Vault only.
  /// @param assets Underlying amount, or `type(uint256).max` for everything.
  /// @return withdrawn Underlying amount actually sent to the vault.
  function recall(uint256 assets) external returns (uint256 withdrawn);
}
