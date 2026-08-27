// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { LimitOrder, LimitOrderLib } from "../../vendor/uniswapx/lib/LimitOrderLib.sol";

/// @notice Pure math and digest helpers for OperatorVault.
///         Share conversion matches OpenZeppelin ERC-4626 (+1 virtual offset).
library VaultLib {
  using LimitOrderLib for LimitOrder;

  uint256 internal constant WAD = 1e18;
  uint256 internal constant YEAR = 365 days;
  uint256 internal constant EPOCH_NONCE_SHIFT = 128;
  bytes4 internal constant ERC1271_FAIL = 0xffffffff;

  bytes32 internal constant TOKEN_PERMISSIONS_TYPEHASH =
    keccak256("TokenPermissions(address token,uint256 amount)");

  bytes32 internal constant PERMIT_WITNESS_TYPEHASH = keccak256(
    abi.encodePacked(
      "PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,",
      LimitOrderLib.PERMIT2_ORDER_TYPE
    )
  );

  bytes32 internal constant PERMIT2_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,uint256 chainId,address verifyingContract)");
  bytes32 internal constant PERMIT2_NAME_HASH = keccak256("Permit2");

  bytes32 internal constant ATTESTATION_TYPEHASH = keccak256(
    "NavAttestation(address vault,uint256 chainId,uint256 epochId,uint256 corridorAssetPrice,uint256 nav,uint256 lastSettledNav,uint256 freeSettlement,uint256 freeCorridor,uint256 validAfter,uint256 validUntil)"
  );
  bytes32 internal constant ATTESTATION_DOMAIN_TYPEHASH =
    keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
  bytes32 internal constant ATTESTATION_NAME_HASH = keccak256("OperatorVault");
  bytes32 internal constant ATTESTATION_VERSION_HASH = keccak256("1");

  struct NavAttestation {
    address vault;
    uint256 chainId;
    uint256 epochId;
    uint256 corridorAssetPrice;
    uint256 nav;
    uint256 lastSettledNav;
    uint256 freeSettlement;
    uint256 freeCorridor;
    uint256 validAfter;
    uint256 validUntil;
  }

  function convertToShares(uint256 assets, uint256 supply, uint256 totalAssets, Math.Rounding rounding)
    internal
    pure
    returns (uint256)
  {
    return Math.mulDiv(assets, supply + 1, totalAssets + 1, rounding);
  }

  function convertToAssets(uint256 shares, uint256 supply, uint256 totalAssets, Math.Rounding rounding)
    internal
    pure
    returns (uint256)
  {
    return Math.mulDiv(shares, totalAssets + 1, supply + 1, rounding);
  }

  /// @notice Settlement-denominated NAV. `priceWad` is WAD-scaled settlement
  ///         tokens per one corridor token. Decimals are constructor-capped at 18.
  function nav(
    uint256 freeSettlement,
    uint256 freeCorridor,
    uint256 priceWad,
    uint8 settlementDecimals,
    uint8 corridorDecimals
  ) internal pure returns (uint256) {
    if (freeCorridor == 0 || priceWad == 0) return freeSettlement;
    if (settlementDecimals >= corridorDecimals) {
      uint256 exp = uint256(settlementDecimals - corridorDecimals);
      return freeSettlement + Math.mulDiv(freeCorridor, priceWad, WAD / (10 ** exp));
    }
    uint256 scale = 10 ** uint256(corridorDecimals - settlementDecimals);
    return freeSettlement + Math.mulDiv(freeCorridor, priceWad, scale * WAD);
  }

  function quotable(uint256 freeBalance, uint256 minReserve) internal pure returns (uint256) {
    if (freeBalance <= minReserve) return 0;
    return freeBalance - minReserve;
  }

  function feeShares(uint256 supply, uint256 feeWad, uint256 elapsed) internal pure returns (uint256) {
    if (supply == 0 || feeWad == 0 || elapsed == 0) return 0;
    return Math.mulDiv(supply, feeWad * elapsed, WAD * YEAR);
  }

  /// @notice Permit2 nonce: trading epoch in the upper 128 bits, quote counter below.
  function tradingNonce(uint256 epoch, uint256 counter) internal pure returns (uint256) {
    return (epoch << EPOCH_NONCE_SHIFT) | counter;
  }

  function epochFromNonce(uint256 nonce) internal pure returns (uint256) {
    return nonce >> EPOCH_NONCE_SHIFT;
  }

  /// @notice Last-claimer residue: if this is the last unit, take the remainder.
  function proRataWithResidue(uint256 claimUnits, uint256 remainingUnits, uint256 remainingOut)
    internal
    pure
    returns (uint256)
  {
    if (claimUnits == 0 || remainingUnits == 0) return 0;
    if (claimUnits == remainingUnits) return remainingOut;
    return Math.mulDiv(remainingOut, claimUnits, remainingUnits);
  }

  function permit2Digest(LimitOrder memory order, address permit2, uint256 chainId)
    internal
    pure
    returns (bytes32)
  {
    bytes32 tokenPermissions = keccak256(
      abi.encode(TOKEN_PERMISSIONS_TYPEHASH, address(order.input.token), order.input.amount)
    );
    bytes32 structHash = keccak256(
      abi.encode(
        PERMIT_WITNESS_TYPEHASH,
        tokenPermissions,
        address(order.info.reactor),
        order.info.nonce,
        order.info.deadline,
        order.hash()
      )
    );
    bytes32 domain = keccak256(
      abi.encode(PERMIT2_DOMAIN_TYPEHASH, PERMIT2_NAME_HASH, chainId, permit2)
    );
    return MessageHashUtils.toTypedDataHash(domain, structHash);
  }

  /// @notice EOA signature check. Strategy and risk signers are keys, not contracts.
  function isSigner(address signer, bytes32 hash, bytes memory signature) internal pure returns (bool) {
    (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
    return err == ECDSA.RecoverError.NoError && recovered == signer;
  }

  function attestationDigest(NavAttestation memory att, address vault, uint256 chainId)
    internal
    pure
    returns (bytes32)
  {
    bytes32 structHash = keccak256(
      abi.encode(
        ATTESTATION_TYPEHASH,
        att.vault,
        att.chainId,
        att.epochId,
        att.corridorAssetPrice,
        att.nav,
        att.lastSettledNav,
        att.freeSettlement,
        att.freeCorridor,
        att.validAfter,
        att.validUntil
      )
    );
    bytes32 domain = keccak256(
      abi.encode(ATTESTATION_DOMAIN_TYPEHASH, ATTESTATION_NAME_HASH, ATTESTATION_VERSION_HASH, chainId, vault)
    );
    return MessageHashUtils.toTypedDataHash(domain, structHash);
  }
}
