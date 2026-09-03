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

  /// @notice Token the position is custodied in (e.g. the aToken). Not
  ///         necessarily one-to-one with the underlying — that is what
  ///         `toScaled` exists for. Must not change after `initialize`: the
  ///         vault reads it once and holds it as an immutable.
  function yieldToken() external view returns (address);

  /// @notice Express a face-value position amount in index-invariant units.
  /// @dev The denomination the vault stores in-kind claim weights in. A
  ///      rebasing position (aTokens) grows in face value over time, so two
  ///      amounts snapshotted at different moments are not comparable and
  ///      adding them as weights would shift value between claimants; scaled
  ///      units are fixed under a rebase. An adapter whose token does not
  ///      rebase returns `assets` unchanged.
  /// @param assets Face-value position amount, in underlying units.
  /// @return scaled `assets` in index-invariant units. Rounds down.
  function toScaled(uint256 assets) external view returns (uint256 scaled);

  /// @notice Value index-invariant units at the position's current face value.
  /// @dev Inverse of `toScaled`, and the reason the vault can hold a reserve
  ///      that keeps up with a rebase instead of freezing at a snapshot.
  ///      Rounds up, so a reserve derived from it never sits under the claim.
  /// @param scaled Index-invariant amount.
  /// @return assets `scaled` in underlying units, at the current index.
  function fromScaled(uint256 scaled) external view returns (uint256 assets);

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

  /// @notice Transfer part of the position out as the yield token itself,
  ///         without touching the external protocol. Vault only. Used by the
  ///         emergency exit when the underlying cannot be withdrawn.
  /// @dev Clamped to the live position: an adapter must send
  ///      `min(assets, position)` rather than revert. On a rebasing token the
  ///      protocol's own rounding can leave the position an atomic unit under
  ///      what the caller asked for, and reverting there would freeze the
  ///      claim it was reserved for permanently.
  /// @param to Recipient of the yield tokens.
  /// @param assets Position amount in underlying units.
  /// @return sent Amount actually transferred. Never more than `assets`.
  function transferHeld(address to, uint256 assets) external returns (uint256 sent);

  /// @notice Recover a token force-sent to the adapter by pushing its full
  ///         balance to the vault. Permissionless: the destination is fixed,
  ///         so the call can only move value into the vault — underlying is
  ///         socialised there, junk becomes guardian-sweepable — and the
  ///         adapter needs no owner. Must reject the yield token, so the
  ///         position itself is never skimmable.
  /// @param token Token to recover. Must not be the yield token.
  function skim(address token) external;
}
