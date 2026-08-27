// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { IERC20 } from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import { VaultLib } from "../libraries/VaultLib.sol";

/**
 * @title IOperatorVault
 * @notice External surface for the RFQ operator vault. Request/claim is
 *         custom: a closed redeem can pay settlement and corridor, so
 *         ERC-7540 `deposit`/`mint`/`withdraw`/`redeem` are not implemented.
 *         Preview methods revert — there is no honest preview until an
 *         attestation exists.
 */
interface IOperatorVault {
  function requestDeposit(uint256 assets, address controller, address owner)
    external
    returns (uint256 requestId);

  function cancelDeposit(uint256 requestId, address controller) external;

  function requestRedeem(uint256 shares, address controller, address owner)
    external
    returns (uint256 requestId);

  function claim(uint256 requestId, address controller, address receiver) external;

  function setOperator(address operator, bool approved) external returns (bool);

  function closeDepositEpoch(uint256 epochId) external;

  function processDepositEpoch(uint256 epochId, VaultLib.NavAttestation calldata attestation, bytes calldata signature)
    external;

  function voidDepositEpoch(uint256 epochId) external;

  function closeRedeemEpoch(uint256 epochId) external;

  function settleRedeemEpoch(uint256 epochId, VaultLib.NavAttestation calldata attestation, bytes calldata signature)
    external;

  function settleRedeemInKind(
    uint256 epochId,
    VaultLib.NavAttestation calldata attestation,
    bytes calldata signature
  ) external;

  /// @notice Last-resort in-kind redeem when the risk signer cannot attest.
  ///         Vault must already be paused. `emergencyExitTimeout` must have
  ///         elapsed since the epoch closed. Pays live free balances,
  ///         including unattested surplus. Anyone may call. Attested in-kind
  ///         while paused also pays live, so a hostile risk key cannot
  ///         pre-settle a partial epoch at zero and block this path.
  /// @param epochId Closed redeem epoch to settle.
  function settleRedeemEmergencyInKind(uint256 epochId) external;

  /// @notice Guardian-only sweep of a non-working ERC-20. Reverts for the
  ///         vault share token, settlement asset, and corridor asset.
  /// @param token Token to transfer. Must not be a working asset.
  /// @param to Recipient. Cannot be the zero address.
  function sweepToken(address token, address to) external;

  /// @notice Guardian-only sweep of forced-in ETH.
  /// @param to Recipient. Cannot be the zero address or this vault.
  function sweepETH(address payable to) external;

  function settlementAsset() external view returns (IERC20);
  function corridorAsset() external view returns (IERC20);
  function strategySigner() external view returns (address);
  function riskSigner() external view returns (address);
  function tradingEpoch() external view returns (uint256);
  function paused() external view returns (bool);
  function closeOnly() external view returns (bool);
  function freeSettlement() external view returns (uint256);
  function freeCorridor() external view returns (uint256);
  function quotableSettlement() external view returns (uint256);
  function quotableCorridor() external view returns (uint256);
  function totalAssets() external view returns (uint256);
}
