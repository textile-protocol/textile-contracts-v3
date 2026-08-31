// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

/// @notice Custom errors for OperatorVault, OperatorVaultFactory, the yield
///         adapters, and VaultOrderExecutor.
library VaultErrors {
  error ZeroAddress();
  error ZeroAmount();
  error InvalidPair();
  error InvalidParams();
  error InvalidDecimals();
  error BelowMinSize();
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
  error SurplusRequiresInKind();
  error InvalidAttestation();
  error InconsistentNav();
  error TransferMismatch();
  error PreviewUnsupported();
  error RotationDelayPending();
  error DuplicateVault();
  error AlreadyClaimed();
  error NothingToClaim();
  error AlreadyInitialized();
  error YieldNotSupported();
  error UnknownVault();
  error UnsupportedOrder();
}
