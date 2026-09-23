/**
 * OperatorVault NAV attestation EIP-712 digest.
 *
 * Mirrors `VaultLib.attestationDigest` in
 * `packages/protocol/contracts/v3/filler/vault/libraries/VaultLib.sol` —
 * domain `OperatorVault` / `2`, verifying contract is the vault itself.
 * Vaults built before the struct dropped `nav` verify the ten-field struct
 * under version `1`, and stay deployed, so both are kept here; the vault's
 * `eip712Domain()` says which it runs (older vaults don't have it).
 * Parity is pinned by
 * `packages/protocol/test/v3/OperatorVault/AttestationDigest.parity.test.ts`;
 * keep the three in lockstep.
 *
 * `verifyAttestation` on-chain requires `att.vault == address(this)` and
 * `att.chainId == block.chainid` before hashing, so the struct's own vault
 * and chainId are also the domain values here.
 */
import { hashTypedData, type Address, type Hex } from 'viem'

import {
  isNavAttestationV1,
  type NavAttestation,
} from './operatorVaultEnvelope'

export const NAV_ATTESTATION_TYPES = {
  NavAttestation: [
    { name: 'vault', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'epochId', type: 'uint256' },
    { name: 'corridorAssetPrice', type: 'uint256' },
    { name: 'lastSettledNav', type: 'uint256' },
    { name: 'freeSettlement', type: 'uint256' },
    { name: 'freeCorridor', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validUntil', type: 'uint256' },
  ],
} as const

/** The older vaults' struct: `nav` after the price. */
export const NAV_ATTESTATION_V1_TYPES = {
  NavAttestation: [
    ...NAV_ATTESTATION_TYPES.NavAttestation.slice(0, 4),
    { name: 'nav', type: 'uint256' },
    ...NAV_ATTESTATION_TYPES.NavAttestation.slice(4),
  ],
} as const

export type NavAttestationVersion = '1' | '2'

export function navAttestationDomain(
  vault: Address,
  chainId: bigint,
  version: NavAttestationVersion = '2'
) {
  return {
    name: 'OperatorVault',
    version,
    chainId,
    verifyingContract: vault,
  } as const
}

/** The digest both vault signers sign for `processDepositEpoch` et al. */
export function navAttestationDigest(attestation: NavAttestation): Hex {
  return isNavAttestationV1(attestation)
    ? hashTypedData({
        domain: navAttestationDomain(
          attestation.vault,
          attestation.chainId,
          '1'
        ),
        types: NAV_ATTESTATION_V1_TYPES,
        primaryType: 'NavAttestation',
        message: attestation,
      })
    : hashTypedData({
        domain: navAttestationDomain(attestation.vault, attestation.chainId),
        types: NAV_ATTESTATION_TYPES,
        primaryType: 'NavAttestation',
        message: attestation,
      })
}
