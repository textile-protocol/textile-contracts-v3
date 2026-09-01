/**
 * OperatorVault NAV attestation EIP-712 digest.
 *
 * Mirrors `VaultLib.attestationDigest` in
 * `packages/protocol/contracts/v3/filler/vault/libraries/VaultLib.sol` —
 * domain `OperatorVault` / `1`, verifying contract is the vault itself.
 * Parity is pinned by
 * `packages/protocol/test/v3/OperatorVault/AttestationDigest.parity.test.ts`;
 * keep the three in lockstep.
 *
 * `verifyAttestation` on-chain requires `att.vault == address(this)` and
 * `att.chainId == block.chainid` before hashing, so the struct's own vault
 * and chainId are also the domain values here.
 */
import { hashTypedData, type Address, type Hex } from 'viem'

import type { NavAttestation } from './operatorVaultEnvelope'

export const NAV_ATTESTATION_TYPES = {
  NavAttestation: [
    { name: 'vault', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'epochId', type: 'uint256' },
    { name: 'corridorAssetPrice', type: 'uint256' },
    { name: 'nav', type: 'uint256' },
    { name: 'lastSettledNav', type: 'uint256' },
    { name: 'freeSettlement', type: 'uint256' },
    { name: 'freeCorridor', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
  ],
} as const

export function navAttestationDomain(vault: Address, chainId: bigint) {
  return {
    name: 'OperatorVault',
    version: '1',
    chainId,
    verifyingContract: vault,
  } as const
}

/** The digest the vault's riskSigner signs for `processDepositEpoch` et al. */
export function navAttestationDigest(attestation: NavAttestation): Hex {
  return hashTypedData({
    domain: navAttestationDomain(attestation.vault, attestation.chainId),
    types: NAV_ATTESTATION_TYPES,
    primaryType: 'NavAttestation',
    message: attestation,
  })
}
