/**
 * Regression — the risk key alone could reprice the vault
 *
 * The vault only checks an attestation from below: live NAV and live free
 * balances must be AT LEAST the signed figures. Nothing bounds them from
 * above, so a risk signer could sign zero floors, and so a zero NAV, for any
 * epoch and the vault accepted it:
 *
 *   (a) `processDepositEpoch` converted the epoch against a zero NAV, so a
 *       minimum-size deposit minted `assets * (supply + 1)` shares and owned
 *       essentially the whole vault; an honest redemption then paid it out.
 *   (b) `settleRedeemEpoch` on an unpaused partial epoch paid off the signed
 *       floors, so a zero-floor attestation burned the redeemers' shares for
 *       nothing and left their value with whoever still held shares.
 *
 * Remediation: attestations are dual-signed like orders. The strategy signer
 * and the risk signer both sign the same digest, so one key alone cannot
 * reprice the vault. Both attacks below now revert `InvalidAttestation`
 * before the figures are even read.
 */
import { expect } from 'chai'

import { PRICE_1, deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import type { DeployedVault } from '../fixtures/operatorVault.fixture'
import { closeDeposit, closeRedeem, seedShares } from '../helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from '../helpers/vaultSignatures'

const LP_DEPOSIT = usdt(1_000_000n)
const ATTACKER_DEPOSIT = usdt(100n) // the vault minimum

/** The attestation the floors cannot reject, signed by the risk key alone. */
async function riskOnlyZeroAttestation(ctx: DeployedVault, epochId: bigint) {
  const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
  const zeroed = { ...att, freeSettlement: 0n, freeCorridor: 0n }
  const riskSig = await signAttestation(ctx.harness, ctx.risk, zeroed)
  return { att: zeroed, riskSig }
}

describe('the risk key alone can no longer reprice the vault', function () {
  it('refuses the zero-NAV attestation that minted a minimum deposit the whole supply', async function () {
    const ctx = await deployOperatorVault()
    const { vault, lp1, lp2: attacker } = ctx
    await seedShares(ctx, lp1, LP_DEPOSIT)

    await vault
      .connect(attacker)
      .requestDeposit(ATTACKER_DEPOSIT, attacker.address, attacker.address)
    const epochId = await closeDeposit(ctx)

    const { att, riskSig } = await riskOnlyZeroAttestation(ctx, epochId)
    // The risk key cannot stand in for the strategy key.
    await expect(
      vault.processDepositEpoch(epochId, att, riskSig, riskSig)
    ).to.be.revertedWithCustomError(vault, 'InvalidAttestation')
    // Nothing minted; the LP still owns the whole supply.
    expect(await vault.totalSupply()).to.equal(LP_DEPOSIT)
    expect(await vault.balanceOf(attacker.address)).to.equal(0n)
  })

  it('refuses the zero-floor attestation that burned a redemption for nothing', async function () {
    const ctx = await deployOperatorVault()
    const { vault, lp1, lp2 } = ctx
    await seedShares(ctx, lp1, LP_DEPOSIT)
    await seedShares(ctx, lp2, usdt(1_000n))

    await vault.connect(lp2).requestRedeem(usdt(1_000n), lp2.address, lp2.address)
    const redeemId = await closeRedeem(ctx)

    const { att, riskSig } = await riskOnlyZeroAttestation(ctx, redeemId)
    await expect(
      vault.settleRedeemEpoch(redeemId, att, riskSig, riskSig)
    ).to.be.revertedWithCustomError(vault, 'InvalidAttestation')
    // The epoch is still closed and lp2's shares are still in it, waiting for
    // an attestation both signers stand behind.
    expect(await vault.closedRedeemEpochId()).to.equal(redeemId)
    expect(await vault.totalSupply()).to.equal(LP_DEPOSIT + usdt(1_000n))
  })
})
