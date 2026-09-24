// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

/**
 * @title IYieldAdapter
 * @notice Idle-yield adapter for OperatorVault. One instance per vault; only its vault may
 *         deploy, recall, or transfer the yield position. `skim` is permissionless and sends
 *         unrelated tokens to the vault. The adapter holds the yield position (e.g. aTokens).
 */
interface IYieldAdapter {
  /// @notice Underlying asset the adapter accepts. The vault's settlement asset.
  function asset() external view returns (address);

  /// @notice Vault this adapter is bound to. Zero until `initialize`.
  function vault() external view returns (address);

  /// @notice Current position value in underlying units, interest included.
  function held() external view returns (uint256);

  /// @notice Token the position is custodied in (e.g. the aToken). Must not change after
  ///         `initialize`: the vault reads it once into an immutable.
  function yieldToken() external view returns (address);

  /// @notice Face-value position amount in index-invariant units. Rounds down.
  /// @dev The vault stores claim weights in these units so a rebase cannot shift value
  ///      between claimants. A non-rebasing adapter returns `assets` unchanged.
  function toScaled(uint256 assets) external view returns (uint256 scaled);

  /// @notice Inverse of `toScaled` at the current index. Rounds up, so a reserve derived from
  ///         it never sits under the claim.
  function fromScaled(uint256 scaled) external view returns (uint256 assets);

  /// @notice One-time binding, called by the vault from its constructor.
  /// @param vault_ Vault to bind. Must be the caller.
  /// @param asset_ Underlying asset to deploy.
  function initialize(address vault_, address asset_) external;

  /// @notice Pull `assets` from the vault and put them to work. Vault only.
  /// @param assets Underlying amount to deploy. Must be nonzero.
  function deploy(uint256 assets) external;

  /// @notice Withdraw `assets` back to the vault. Vault only.
  /// @dev A reverting `recall` must move nothing: `tryRecallAllIdle` re-reads `held()` only
  ///      on success. Returning less than `assets` is fine.
  /// @param assets Underlying amount, or `type(uint256).max` for everything.
  /// @return withdrawn Underlying amount actually sent to the vault.
  function recall(uint256 assets) external returns (uint256 withdrawn);

  /// @notice Transfer part of the position out as the yield token itself, without touching
  ///         the external protocol. Vault only. Used when the underlying cannot be withdrawn.
  /// @dev Must send `min(assets, position)` rather than revert: a rebasing token's own
  ///      rounding can leave the position an atomic unit under the request.
  /// @param to Recipient of the yield tokens.
  /// @param assets Position amount in underlying units.
  /// @return sent Amount actually transferred. Never more than `assets`.
  function transferHeld(address to, uint256 assets) external returns (uint256 sent);

  /// @notice Push the full balance of a force-sent token to the vault. Permissionless, since
  ///         the destination is fixed. Must reject the yield token.
  /// @param token Token to recover. Must not be the yield token.
  function skim(address token) external;
}
