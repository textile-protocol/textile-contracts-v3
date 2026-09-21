// SPDX-License-Identifier: BUSL-1.1
// Copyright (c) 2026 Textile, Inc.
pragma solidity 0.8.30;

import { Math } from "@openzeppelin/contracts/utils/math/Math.sol";

import { LimitOrder } from "../filler/vendor/uniswapx/lib/LimitOrderLib.sol";
import { VaultLib } from "../filler/vault/libraries/VaultLib.sol";
import { VaultPolicy } from "../filler/vault/libraries/VaultPolicy.sol";
import { VaultTypes } from "../filler/vault/libraries/VaultTypes.sol";

/// @notice Test harness so Hardhat coverage sees VaultLib.
contract VaultLibHarness {
  function convertToShares(uint256 assets, uint256 supply, uint256 totalAssets, bool roundUp)
    external
    pure
    returns (uint256)
  {
    return VaultLib.convertToShares(
      assets, supply, totalAssets, roundUp ? Math.Rounding.Ceil : Math.Rounding.Floor
    );
  }

  function nav(
    uint256 freeSettlement,
    uint256 freeCorridor,
    uint256 priceWad,
    uint8 settlementDecimals,
    uint8 corridorDecimals
  ) external pure returns (uint256) {
    return VaultLib.nav(freeSettlement, freeCorridor, priceWad, settlementDecimals, corridorDecimals);
  }

  function quotable(uint256 freeBalance, uint256 minReserve) external pure returns (uint256) {
    return VaultLib.quotable(freeBalance, minReserve);
  }

  function feeShares(uint256 supply, uint256 feeWad, uint256 elapsed) external pure returns (uint256) {
    return VaultLib.feeShares(supply, feeWad, elapsed);
  }

  function chargeableGain(uint256 navNow, uint256 basketValue, uint256 absValue)
    external
    pure
    returns (uint256)
  {
    return VaultLib.chargeableGain(navNow, basketValue, absValue);
  }

  function performanceFeeShares(uint256 navAssets, uint256 supply, uint256 gain, uint256 feeWad)
    external
    pure
    returns (uint256)
  {
    return VaultLib.performanceFeeShares(navAssets, supply, gain, feeWad);
  }

  function perShareTotal(uint256 perShareWad, uint256 supply) external pure returns (uint256) {
    return VaultLib.perShareTotal(perShareWad, supply);
  }

  function basketPerShare(uint256 units, uint256 supply) external pure returns (uint256) {
    return VaultLib.basketPerShare(units, supply);
  }

  function markAfter(uint256 navAssets, uint256 supply, uint256 markWad) external pure returns (uint256) {
    return VaultLib.markAfter(navAssets, supply, markWad);
  }

  function splitFee(uint256 shares, uint256 protocolShareWad)
    external
    pure
    returns (uint256 operatorShares, uint256 protocolShares)
  {
    return VaultLib.splitFee(shares, protocolShareWad);
  }

  function epochFromNonce(uint256 nonce) external pure returns (uint256) {
    return VaultLib.epochFromNonce(nonce);
  }

  function proRataWithResidue(uint256 claimUnits, uint256 remainingUnits, uint256 remainingOut)
    external
    pure
    returns (uint256)
  {
    return VaultLib.proRataWithResidue(claimUnits, remainingUnits, remainingOut);
  }

  function permit2Digest(LimitOrder memory order, address permit2, uint256 chainId)
    external
    pure
    returns (bytes32)
  {
    return VaultLib.permit2Digest(order, permit2, chainId);
  }

  function attestationDigest(VaultLib.NavAttestation memory att, address vault, uint256 chainId)
    external
    pure
    returns (bytes32)
  {
    return VaultLib.attestationDigest(att, vault, chainId);
  }

  function isSigner(address signer, bytes32 hash, bytes calldata signature) external pure returns (bool) {
    return VaultLib.isSigner(signer, hash, signature);
  }

  function validateConfig(VaultTypes.VaultConfig memory cfg) external view {
    VaultPolicy.validateConfig(cfg);
  }

  function orderPolicyOk(LimitOrder memory order, VaultPolicy.OrderContext memory ctx)
    external
    view
    returns (bool)
  {
    return VaultPolicy.orderPolicyOk(order, ctx);
  }

  function verifyAttestation(
    VaultLib.NavAttestation calldata att,
    bytes calldata strategySignature,
    bytes calldata riskSignature,
    uint256 epochId,
    address vault
  ) external view returns (uint256) {
    return VaultPolicy.verifyAttestation(att, strategySignature, riskSignature, epochId, vault);
  }
}
