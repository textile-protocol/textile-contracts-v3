// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

/// @notice Constants shared across the filler-network contracts so the same
///         value never lives in two places (audit §6 code improvement 1).
library FillerConstants {
  /// @notice Preferred-filler set bound, enforced by both
  ///         `PreferredFillerValidation` at fill time and the vault order
  ///         policy at signing time.
  uint256 internal constant MAX_PREFERRED_FILLERS = 10;
}
