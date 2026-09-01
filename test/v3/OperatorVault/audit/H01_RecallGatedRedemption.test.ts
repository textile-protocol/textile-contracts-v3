/**
 * Audit proof — H-01
 *
 * Every redeem exit path (`settleRedeemEpoch`, `settleRedeemInKind`,
 * `settleRedeemEmergencyInKind`) calls `_recallAll()` first. `_recallAll`
 * withdraws the FULL adapter position with a single `pool.withdraw(max)`. If
 * the Aave reserve cannot honour that withdrawal — paused/frozen reserve, or,
 * far more routinely, available liquidity below the vault's position — the
 * withdraw reverts and the whole settlement reverts with it.
 *
 * The consequence: while Aave withdrawal is impaired, redeemers cannot exit at
 * all. The "last-resort" emergency path — whose stated purpose is to exit when
 * the risk signer is unavailable — is defeated by the same external condition.
 * The aToken value is stranded until Aave recovers; it is NOT distributable
 * in-kind. This is a liveness / fund-lockup finding, not a fix; it demonstrates
 * the invariant break. Status: Unresolved.
 */
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { PRICE_1, deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import { closeRedeem, seedShares } from '../helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from '../helpers/vaultSignatures'

describe('AUDIT H-01 — redemption is fully gated on a successful Aave recall', function () {
  it('freezes cash, attested in-kind, AND the emergency exit while Aave withdraw is down', async function () {
    const ctx = await deployOperatorVault({ enableYield: true })
    await seedShares(ctx, ctx.lp1, usdt(10_000n))
    await ctx.vault.allocateIdle() // 10k in Aave, 0 liquid
    expect(await ctx.adapter.held()).to.equal(usdt(10_000n))

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(2_000n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await closeRedeem(ctx)

    // Aave withdrawal becomes impossible (frozen reserve / insufficient
    // available liquidity — routine at high utilisation).
    await ctx.aavePool.setWithdrawReverts(true)

    // 1) Cash settlement — reverts on the recall.
    {
      const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig)).to.be.reverted
    }

    // 2) Attested in-kind, after the in-kind timeout — reverts on the recall.
    await time.increase(await ctx.vault.emergencyExitTimeout()) // clears in-kind + emergency
    {
      const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await expect(ctx.vault.settleRedeemInKind(redeemId, att, sig)).to.be.reverted
    }

    // 3) The last-resort emergency exit — needs no risk signer, only pause +
    //    timeout — ALSO reverts on the recall. Redeemers are fully stuck.
    await ctx.vault.connect(ctx.guardian).pause()
    await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId)).to.be.reverted

    // The value is not lost — it is stranded in Aave with no in-protocol path
    // to hand it to redeemers. Nothing has been paid out.
    expect(await ctx.adapter.held()).to.equal(usdt(10_000n))
    expect(await ctx.vault.reservedSettlement()).to.equal(0n)
    const before = await ctx.settlement.balanceOf(ctx.lp1.address)

    // Recovery is only possible once the EXTERNAL protocol recovers.
    await ctx.aavePool.setWithdrawReverts(false)
    await ctx.vault.settleRedeemEmergencyInKind(redeemId)
    await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.be.greaterThan(0n)
  })
})
