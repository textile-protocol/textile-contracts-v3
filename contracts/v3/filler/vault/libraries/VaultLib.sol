// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";
import { ECDSA } from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import { MessageHashUtils } from "@openzeppelin/contracts/utils/cryptography/MessageHashUtils.sol";

import { LimitOrder, LimitOrderLib } from "../../vendor/uniswapx/lib/LimitOrderLib.sol";

/// @notice Pure math and digest helpers for OperatorVault.
library VaultLib {
  using LimitOrderLib for LimitOrder;

  uint256 internal constant WAD = 1e18;
  uint256 internal constant YEAR = 365 days;
  /// @notice Largest dilution one fee checkpoint may charge, WAD.
  uint256 internal constant MAX_FEE_ACCRUAL_WAD = 5e17;
  /// @notice Permit2 nonce layout: trading epoch in the upper 128 bits, quote counter below.
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

  /// @notice ERC-4626 conversion with the +1 virtual offset, which bounds donation inflation
  ///         on a near-empty vault. `totalAssets` is the attested NAV, not a balance read.
  function convertToShares(uint256 assets, uint256 supply, uint256 totalAssets, Math.Rounding rounding)
    internal
    pure
    returns (uint256)
  {
    return Math.mulDiv(assets, supply + 1, totalAssets + 1, rounding);
  }

  /// @notice Settlement-denominated NAV. `priceWad` is WAD settlement per one corridor token.
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

  /// @notice Management-fee mint, grossed up by `1 - f` so the dilution is exactly `f` and
  ///         not `f / (1 + f)`. The clamp keeps the denominator positive.
  function feeShares(uint256 supply, uint256 feeWad, uint256 elapsed) internal pure returns (uint256) {
    if (supply == 0 || feeWad == 0 || elapsed == 0) return 0;
    uint256 accrual = feeWad * elapsed;
    uint256 ceiling = MAX_FEE_ACCRUAL_WAD * YEAR;
    if (accrual > ceiling) accrual = ceiling;
    return Math.mulDiv(supply, accrual, WAD * YEAR - accrual);
  }

  /// @notice Split one fee accrual. The protocol leg rounds down, the operator keeps the dust.
  function splitFee(uint256 shares, uint256 protocolShareWad)
    internal
    pure
    returns (uint256 operatorShares, uint256 protocolShares)
  {
    protocolShares = Math.mulDiv(shares, protocolShareWad, WAD);
    operatorShares = shares - protocolShares;
  }

  /// @notice NAV above the higher mark: the revalued basket strips FX on held inventory, the
  ///         absolute mark (zero when the floor is off) defers gain while under the high.
  function chargeableGain(uint256 navNow, uint256 basketValue, uint256 absValue)
    internal
    pure
    returns (uint256)
  {
    uint256 bar = Math.max(basketValue, absValue);
    return navNow > bar ? navNow - bar : 0;
  }

  /// @notice `feeWad` of `gain`, minted against post-fee NAV so holders keep exactly `1 - feeWad`.
  function performanceFeeShares(uint256 navAssets, uint256 supply, uint256 gain, uint256 feeWad)
    internal
    pure
    returns (uint256)
  {
    if (feeWad == 0 || gain == 0) return 0;
    uint256 feeAssets = Math.mulDiv(gain, feeWad, WAD);
    if (feeAssets == 0) return 0;
    return Math.mulDiv(feeAssets, supply, navAssets - feeAssets);
  }

  /// @notice A per-share WAD figure scaled out to `supply` shares.
  function perShareTotal(uint256 perShareWad, uint256 supply) internal pure returns (uint256) {
    return Math.mulDiv(perShareWad, supply, WAD);
  }

  /// @notice `units` per share, WAD-scaled. Rounds up so `perShareTotal` reads back at least what
  ///         was written.
  function basketPerShare(uint256 units, uint256 supply) internal pure returns (uint256) {
    if (supply == 0) return 0;
    return Math.mulDiv(units, WAD, supply, Math.Rounding.Ceil);
  }

  /// @notice Never re-bases down, so a recovery is not charged twice.
  function markAfter(uint256 navAssets, uint256 supply, uint256 markWad) internal pure returns (uint256) {
    return Math.max(markWad, Math.mulDiv(navAssets, WAD, supply));
  }

  function epochFromNonce(uint256 nonce) internal pure returns (uint256) {
    return nonce >> EPOCH_NONCE_SHIFT;
  }

  /// @notice Pro rata, except the last unit takes the whole remainder.
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
