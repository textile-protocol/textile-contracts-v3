/**
 * Pins the TypeScript NAV-attestation digest to the Solidity one.
 *
 * The keeper signs off-chain with `navAttestationDigest` from
 * `@textile/constants`; the vault verifies with `VaultLib.attestationDigest`.
 * A silent mismatch bricks every epoch (`InvalidAttestation` on every
 * `processDepositEpoch`), so this test computes both over the same structs
 * and demands equality.
 */
import { expect } from 'chai'
import { Wallet } from 'ethers'
import { ethers } from 'hardhat'

import { navAttestationDigest } from '../../../constants/src/operatorVaultAttestation'
import type { VaultLibHarness } from '../../../typechain-types'

const MAX_UINT256 = (1n << 256n) - 1n

async function deployHarness(): Promise<VaultLibHarness> {
  const Policy = await ethers.getContractFactory('VaultPolicy')
  const policy = await Policy.deploy()
  const Harness = await ethers.getContractFactory('VaultLibHarness', {
    libraries: { VaultPolicy: await policy.getAddress() },
  })
  return Harness.deploy()
}

function attestation(overrides: Partial<Record<string, bigint | string>> = {}) {
  return {
    vault: Wallet.createRandom().address as `0x${string}`,
    chainId: 42220n,
    epochId: 3n,
    corridorAssetPrice: 651_234_567_890_123_456n,
    nav: 1_234_567_000_000n,
    lastSettledNav: 1_200_000_000_000n,
    freeSettlement: 900_000_000_000n,
    freeCorridor: 500_000_000_000_000_000_000_000n,
    validAfter: 1_754_388_000n,
    validUntil: 1_754_388_600n,
    ...overrides,
  }
}

describe('NAV attestation digest parity (TS vs Solidity)', () => {
  let harness: VaultLibHarness

  before(async () => {
    harness = await deployHarness()
  })

  it('matches on a representative attestation', async () => {
    const att = attestation()
    expect(navAttestationDigest(att)).to.equal(
      await harness.attestationDigest(att, att.vault, att.chainId)
    )
  })

  it('matches at the uint256 extremes', async () => {
    const att = attestation({
      corridorAssetPrice: MAX_UINT256,
      nav: MAX_UINT256,
      lastSettledNav: 0n,
      freeSettlement: MAX_UINT256,
      freeCorridor: 0n,
      epochId: MAX_UINT256,
    })
    expect(navAttestationDigest(att)).to.equal(
      await harness.attestationDigest(att, att.vault, att.chainId)
    )
  })

  it('binds vault and chainId — a different domain is a different digest', async () => {
    const att = attestation()
    const base = navAttestationDigest(att)
    const otherVault = attestation({ vault: Wallet.createRandom().address })
    expect(
      navAttestationDigest({ ...att, vault: otherVault.vault })
    ).to.not.equal(base)
    expect(navAttestationDigest({ ...att, chainId: 8453n })).to.not.equal(base)
  })

  it('a signature over the TS digest recovers on-chain via isSigner', async () => {
    const att = attestation()
    const risk = Wallet.createRandom()
    const signature = risk.signingKey.sign(navAttestationDigest(att)).serialized
    expect(
      await harness.isSigner(risk.address, navAttestationDigest(att), signature)
    ).to.equal(true)
  })
})
