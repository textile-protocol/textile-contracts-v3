// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

/// @notice Custom errors for the vault stack.
/// @dev An interface so `OperatorVault` can inherit it: errors raised inside delegatecalled
///      `VaultPolicy` code would otherwise be missing from the vault ABI.
interface VaultErrors {
  error ZeroAddress();
  error ZeroAmount();
  error InvalidPair();
  error InvalidParams();
  error InvalidDecimals();
  error BelowMinSize();
  error CorridorDepositsDisabled();
  error EnforcedPause();
  error NotAuthorized();
  error EpochNotOpen();
  error EpochNotClosed();
  error EpochNotReady();
  error EpochNotClaimable();
  error CancelWindowClosed();
  error RedeemEpochOutstanding();
  error CloseCooldownActive();
  error InsufficientSettlement();
  error TimeoutNotReached();
  error PauseRequired();
  error InvalidAttestation();
  error InconsistentNav();
  error TransferMismatch();
  error RotationDelayPending();
  error AlreadyClaimed();
  error NothingToClaim();
  error AlreadyInitialized();
  error YieldNotSupported();
  error YieldNotLiquid();
  error UnknownVault();
  error UnsupportedOrder();
  error CallerNotPreferredFiller();
}
