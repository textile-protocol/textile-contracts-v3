/**
 * Regression — a signed NAV attestation could be banked and used much later
 *
 * `verifyAttestation` only checked `validAfter <= now <= validUntil`, with no
 * bound on the window. The Stitch strategy signer never checked the window
 * either, so a risk-key holder could get a co-signature on an attestation
 * with `validUntil = 2^256 - 1` while its price matched the market, hold it,
 * and settle the epoch months later at that price. Reproduced: a deposit
 * epoch processed 365 days after close at the banked price minted twice the
 * shares a fresh half-price attestation would have.
 *
 * Found in the 2026-09-22 FX stack audit
 * (docs/audits/2026-09-22-fx-stack,
 * `stitch-bot/protocol/attest/check_attestation:attestation-validity-window-unchecked`).
 *
 * Remediation (option A in the PR): an attestation can only settle its epoch
 * while that epoch could still settle the normal way — until
 * `closedAt + valuationTimeout` for a deposit epoch (anyone may void it then),
 * or `closedAt + emergencyExitTimeout` for a redeem epoch (anyone may exit in
 * kind). The bound is on the time of use, so honest signers change nothing.
 */
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { PRICE_1, deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import { closeDeposit, closeRedeem, seedShares } from '../helpers/vaultLifecycle'
import { attestationSignatures, freshAttestation } from '../helpers/vaultSignatures'

describe('an attestation expires with its epoch', function () {
  it('refuses a banked deposit attestation once the valuation window has passed', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(1_000n), ctx.lp2.address, ctx.lp2.address)
    const epochId = await closeDeposit(ctx)

    // Signed now, with no expiry to speak of, and held.
    const banked = { ...(await freshAttestation(ctx.vault, epochId, PRICE_1)), validUntil: ethers.MaxUint256 }
    const sigs = await attestationSignatures(ctx, banked)

    const { closedAt } = await ctx.vault.epochs(epochId)
    await time.increaseTo(closedAt + (await ctx.vault.valuationTimeout()) + 1n)
    await expect(ctx.vault.processDepositEpoch(epochId, banked, ...sigs)).to.be.revertedWithCustomError(
      ctx.vault,
      'InvalidAttestation'
    )
  })

  it('still settles a deposit epoch right up to the valuation deadline', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await closeDeposit(ctx)
    const { closedAt } = await ctx.vault.epochs(epochId)
    const deadline = closedAt + (await ctx.vault.valuationTimeout())

    // The attestation's own window runs past the deadline; only the time of use matters.
    await time.setNextBlockTimestamp(deadline)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1, Number(deadline))
    await expect(ctx.vault.processDepositEpoch(epochId, att, ...(await attestationSignatures(ctx, att)))).to.not.be
      .reverted
  })

  it('bounds a redeem epoch by the emergency exit window instead', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(500n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await closeRedeem(ctx)
    const { closedAt } = await ctx.vault.epochs(epochId)
    const valuationDeadline = closedAt + (await ctx.vault.valuationTimeout())
    const exitDeadline = closedAt + (await ctx.vault.emergencyExitTimeout())

    // Past the deposit-style window but inside the redeem one: a snapshot proves it settles.
    await time.increaseTo(valuationDeadline + 60n)
    const inside = await freshAttestation(ctx.vault, epochId, PRICE_1)
    await expect(
      ctx.vault.settleRedeemEpoch.staticCall(epochId, inside, ...(await attestationSignatures(ctx, inside)))
    ).to.not.be.reverted

    // Past the emergency exit deadline: refused, even freshly signed.
    await time.increaseTo(exitDeadline + 1n)
    const late = await freshAttestation(ctx.vault, epochId, PRICE_1)
    await expect(
      ctx.vault.settleRedeemEpoch(epochId, late, ...(await attestationSignatures(ctx, late)))
    ).to.be.revertedWithCustomError(ctx.vault, 'InvalidAttestation')
  })
})
