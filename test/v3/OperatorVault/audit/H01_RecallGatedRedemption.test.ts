/**
 * Audit regression — H-01 (Resolved)
 *
 * Originally: every redeem exit path (`settleRedeemEpoch`, `settleRedeemInKind`,
 * `settleRedeemEmergencyInKind`) recalled the FULL adapter position with a
 * strict `pool.withdraw(max)` first, so an impaired Aave reserve froze every
 * exit — including the last-resort emergency path — and stranded the position.
 *
 * Remediation: the emergency exit recalls best-effort and never lets the
 * external protocol revert it. Whatever Aave cannot pay back is booked as a
 * pro-rata in-kind claim on the aToken, which redeemers collect on their own
 * schedule. That holds for a paused reserve too, where Aave blocks aToken
 * transfers exactly like it blocks withdrawals — settlement never touches the
 * token, so the pause can only delay a claim, never the exit. The cash and
 * attested in-kind paths stay strict by design: the pause + emergency ladder
 * is the degraded-conditions exit.
 */
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import {
  PRICE_1,
  RAY,
  type VaultInitOverrides,
  accrueAaveInterest,
  deployOperatorVault,
  usdt,
} from '../fixtures/operatorVault.fixture'
import { armEmergencyExit, closeRedeem, seedShares } from '../helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from '../helpers/vaultSignatures'

/** 10k supplied to Aave, 2k of shares queued for redemption and closed. */
async function strandedVault(overrides: VaultInitOverrides = {}) {
  const ctx = await deployOperatorVault({ enableYield: true, ...overrides })
  await seedShares(ctx, ctx.lp1, usdt(10_000n))
  await ctx.vault.allocateIdle()
  await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(2_000n), ctx.lp1.address, ctx.lp1.address)
  const redeemId = await closeRedeem(ctx)
  return { ctx, redeemId }
}

describe('AUDIT H-01 — emergency exit survives an impaired Aave recall', function () {
  it('pays the stranded position pro-rata in aTokens while Aave withdraw is down', async function () {
    const { ctx, redeemId } = await strandedVault()
    expect(await ctx.adapter.held()).to.equal(usdt(10_000n))

    await ctx.aavePool.setWithdrawReverts(true)

    // Cash and attested in-kind stay strict: they need the real underlying.
    await time.increase(await ctx.vault.emergencyExitTimeout())
    {
      const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig)).to.be.reverted
      const att2 = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig2 = await signAttestation(ctx.harness, ctx.risk, att2)
      await expect(ctx.vault.settleRedeemInKind(redeemId, att2, sig2)).to.be.reverted
    }

    // The last-resort exit no longer waits for Aave: it settles the epoch's
    // pro-rata share of the stranded position in aTokens.
    await ctx.vault.connect(ctx.guardian).pause()
    await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId))
      .to.emit(ctx.vault, 'RedeemYieldSettled')
      .withArgs(redeemId, usdt(2_000n))
    const vaultAddr = await ctx.vault.getAddress()
    expect(await ctx.adapter.held()).to.equal(usdt(8_000n))
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(usdt(2_000n))
    // Transfers still work, so nothing was left behind in the adapter.
    expect((await ctx.vault.yieldReserves()).pendingPull).to.equal(0n)

    // The redeemer claims the aTokens...
    await expect(ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address))
      .to.emit(ctx.vault, 'ClaimedYield')
      .withArgs(ctx.lp1.address, ctx.lp1.address, redeemId, usdt(2_000n))
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(2_000n))
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(0n)

    // ...and redeems them against Aave directly once it recovers, without the
    // vault in the loop.
    await ctx.aavePool.setWithdrawReverts(false)
    await ctx.aavePool
      .connect(ctx.lp1)
      .withdraw(await ctx.settlement.getAddress(), ethers.MaxUint256, ctx.lp1.address)
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(0n)
  })

  it('settles through a fully paused reserve, which blocks aToken transfers too', async function () {
    const { ctx, redeemId } = await strandedVault()
    // A paused Aave reserve rejects `withdraw` AND `finalizeTransfer`, so the
    // exit cannot move the aToken either. Booking the claim has to be enough.
    await ctx.aavePool.setReservePaused(true)
    await armEmergencyExit(ctx)

    await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId))
      .to.emit(ctx.vault, 'RedeemYieldSettled')
      .withArgs(redeemId, usdt(2_000n))

    // The position is still in the adapter, booked as owed and out of NAV.
    const reserves = await ctx.vault.yieldReserves()
    expect(reserves.pendingPull).to.equal(usdt(2_000n))
    expect(reserves.weight).to.equal(usdt(2_000n))
    expect(await ctx.adapter.held()).to.equal(usdt(10_000n))
    expect(await ctx.vault.freeSettlement()).to.equal(usdt(8_000n))

    // A claim cannot be paid while the pause holds, and burns nothing trying.
    await expect(
      ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'YieldNotLiquid')

    // The pause lifts, the slice crosses, and the claim lands in full.
    await ctx.aavePool.setReservePaused(false)
    await expect(ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address))
      .to.emit(ctx.vault, 'YieldPullSynced')
      .withArgs(usdt(2_000n))
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(2_000n))
    expect((await ctx.vault.yieldReserves()).pendingPull).to.equal(0n)
  })

  it('keeps a deferred slice out of reach of a later recall', async function () {
    const { ctx, redeemId } = await strandedVault()
    await ctx.aavePool.setReservePaused(true)
    await armEmergencyExit(ctx)
    await ctx.vault.settleRedeemEmergencyInKind(redeemId)

    // 10% accrues while the reserve is still frozen, so the redeemer's slice
    // is worth 2,200 by the time Aave comes back — not the 2,000 it was worth
    // at settlement. `recallAll` is permissionless and pulls the slice out
    // before recalling, so anyone can unstick it; what it must never do is
    // recall it as ordinary inventory the redeemer can no longer reach.
    await accrueAaveInterest(ctx, (RAY * 11n) / 10n)
    await ctx.aavePool.setReservePaused(false)
    await expect(ctx.vault.recallAll())
      .to.emit(ctx.vault, 'YieldPullSynced')
      .withArgs(usdt(2_200n))
    const vaultAddr = await ctx.vault.getAddress()
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(usdt(2_200n))
    expect((await ctx.vault.yieldReserves()).pendingPull).to.equal(0n)

    await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(2_200n))
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(0n)
  })

  it('keeps interest that accrues while the reserve is paused with the claim', async function () {
    // The deferred slice rebases *inside the adapter*, where the claim-weight
    // mechanism cannot see it. A face-value reserve would stop covering it:
    // the excess would count as live-share NAV, be recallable as ordinary
    // inventory, and a later emergency epoch could book part of it again.
    const { ctx, redeemId } = await strandedVault()
    await ctx.aavePool.setReservePaused(true)
    await armEmergencyExit(ctx)
    await ctx.vault.settleRedeemEmergencyInKind(redeemId)

    // 8k of the 10k position backs live shares; 2k is owed to the redeemer.
    expect(await ctx.vault.freeSettlement()).to.equal(usdt(8_000n))

    // 10% lands with the reserve still frozen. The vault's share grows to
    // 8,800 and the redeemer's to 2,200 — the reserve tracks the rebase
    // rather than staying at its settlement-time 2,000.
    await accrueAaveInterest(ctx, (RAY * 11n) / 10n)
    expect(await ctx.adapter.held()).to.equal(usdt(11_000n))
    expect(await ctx.vault.freeSettlement()).to.equal(usdt(8_800n))

    // Aave recovers and the claim takes the rebased slice, not the snapshot.
    await ctx.aavePool.setReservePaused(false)
    await expect(ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address))
      .to.emit(ctx.vault, 'YieldPullSynced')
      .withArgs(usdt(2_200n))
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(2_200n))
    expect(await ctx.adapter.held()).to.equal(usdt(8_800n))
    const reserves = await ctx.vault.yieldReserves()
    expect(reserves.pendingPull).to.equal(0n)
    expect(reserves.weight).to.equal(0n)
  })

  it('lets interest accrued after settlement follow the claim', async function () {
    const { ctx, redeemId } = await strandedVault()
    await ctx.aavePool.setWithdrawReverts(true)
    await armEmergencyExit(ctx)
    await ctx.vault.settleRedeemEmergencyInKind(redeemId)

    const vaultAddr = await ctx.vault.getAddress()
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(usdt(2_000n))

    // 10% of interest lands while the claim is outstanding. The claim leg is a
    // weight over the live balance, not a frozen amount, so the redeemer takes
    // the rebased position and the vault is left with nothing orphaned.
    await accrueAaveInterest(ctx, (RAY * 11n) / 10n)
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(usdt(2_200n))

    await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(2_200n))
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(0n)
    expect((await ctx.vault.yieldReserves()).weight).to.equal(0n)
  })

  it('splits two emergency epochs by scaled units, not by stale face values', async function () {
    // Two epochs settle at different liquidity indices before either claims.
    // Face-value weights would be denominated in different money — 2,000 at
    // index 1.0 and 2,200 at index 1.1 are the same position — and splitting
    // the pot 2000:2200 would move ~105 of the first epoch's interest to the
    // second. Scaled weights are 2000:2000, so each side takes 2,200.
    const ctx = await deployOperatorVault({ enableYield: true })
    await seedShares(ctx, ctx.lp1, usdt(10_000n))
    await seedShares(ctx, ctx.lp2, usdt(10_000n))
    await ctx.vault.allocateIdle()

    await ctx.aavePool.setWithdrawReverts(true)
    await ctx.vault.connect(ctx.guardian).pause()

    // Epoch A: 2k of 20k supply, so 2,000 of the 20,000 stranded position.
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(2_000n), ctx.lp1.address, ctx.lp1.address)
    const epochA = await closeRedeem(ctx)
    await time.increase(await ctx.vault.emergencyExitTimeout())
    await expect(ctx.vault.settleRedeemEmergencyInKind(epochA))
      .to.emit(ctx.vault, 'RedeemYieldSettled')
      .withArgs(epochA, usdt(2_000n))

    // 10% of interest lands between the two settlements: A's booked slice is
    // now worth 2,200 and the adapter's remaining 18,000 is worth 19,800.
    await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(2_000n), ctx.lp2.address, ctx.lp2.address)
    await accrueAaveInterest(ctx, (RAY * 11n) / 10n)

    // Epoch B: 2k of the 18k supply left, so 2,200 of the 19,800 stranded.
    const epochB = await closeRedeem(ctx)
    await time.increase(await ctx.vault.emergencyExitTimeout())
    await expect(ctx.vault.settleRedeemEmergencyInKind(epochB))
      .to.emit(ctx.vault, 'RedeemYieldSettled')
      .withArgs(epochB, usdt(2_200n))

    const vaultAddr = await ctx.vault.getAddress()
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(usdt(4_400n))
    // Both epochs hold the same position, so both weigh the same.
    expect((await ctx.vault.yieldReserves()).weight).to.equal(usdt(4_000n))

    await ctx.vault.connect(ctx.lp1).claim(epochA, ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).claim(epochB, ctx.lp2.address, ctx.lp2.address)
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(2_200n))
    expect(await ctx.aToken.balanceOf(ctx.lp2.address)).to.equal(usdt(2_200n))
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(0n)
    expect((await ctx.vault.yieldReserves()).weight).to.equal(0n)
  })

  it('splits a mixed exit into liquid settlement plus stranded aTokens', async function () {
    // Same setup, with a liquidity floor: 9k in Aave, 1k left liquid.
    const { ctx, redeemId } = await strandedVault({ minLiquidSettlement: usdt(1_000n) })
    expect(await ctx.adapter.held()).to.equal(usdt(9_000n))

    await ctx.aavePool.setWithdrawReverts(true)
    await armEmergencyExit(ctx)

    // 20% of 1k liquid and 20% of the 9k stranded position.
    await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(redeemId, true, usdt(2_000n), usdt(200n), 0n)
    expect(await ctx.vault.reservedSettlement()).to.equal(usdt(200n))

    const before = await ctx.settlement.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.equal(usdt(200n))
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(1_800n))
    expect(await ctx.vault.reservedSettlement()).to.equal(0n)
  })

  it('gates a funded claim on a later deferred epoch, which Aave gates anyway', async function () {
    // Epoch A's aTokens reach the vault; epoch B then settles into a full
    // pause and sets the aggregate `pendingYieldPull`, so A's claim reverts
    // YieldNotLiquid. The gate is load-bearing: the pot is split pro-rata by
    // aggregate weight, so paying A while B's tokens are still in the adapter
    // would dilute A against a pot that has not fully landed. Nothing is lost
    // by waiting — the payout is itself an aToken transfer, which the same
    // pause blocks, so A could not have been paid either way.
    const ctx = await deployOperatorVault({ enableYield: true })
    await seedShares(ctx, ctx.lp1, usdt(10_000n))
    await seedShares(ctx, ctx.lp2, usdt(10_000n))
    await ctx.vault.allocateIdle()

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(2_000n), ctx.lp1.address, ctx.lp1.address)
    const epochA = await closeRedeem(ctx)
    await ctx.aavePool.setWithdrawReverts(true) // transfers still work
    await armEmergencyExit(ctx)
    await ctx.vault.settleRedeemEmergencyInKind(epochA)

    const vaultAddr = await ctx.vault.getAddress()
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(usdt(2_000n))
    expect((await ctx.vault.yieldReserves()).pendingPull).to.equal(0n)

    // Now the reserve pauses outright and a second epoch settles into it.
    await ctx.aavePool.setReservePaused(true)
    await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(2_000n), ctx.lp2.address, ctx.lp2.address)
    const epochB = await closeRedeem(ctx)
    await time.increase(await ctx.vault.emergencyExitTimeout())
    await ctx.vault.settleRedeemEmergencyInKind(epochB)
    expect((await ctx.vault.yieldReserves()).pendingPull).to.equal(usdt(2_000n))

    await expect(
      ctx.vault.connect(ctx.lp1).claim(epochA, ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'YieldNotLiquid')
    // The vault holds A's tokens, but they are aTokens: paying them out runs
    // through the same `validateTransfer` the pause is rejecting.
    await expect(
      ctx.aToken.connect(ctx.lp1).transfer(ctx.other.address, 1n)
    ).to.be.revertedWith('ATokenMock: transfer off')

    // Pause lifts, both epochs claim in full, nothing stranded.
    await ctx.aavePool.setReservePaused(false)
    await ctx.vault.connect(ctx.lp1).claim(epochA, ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).claim(epochB, ctx.lp2.address, ctx.lp2.address)
    expect(await ctx.aToken.balanceOf(ctx.lp1.address)).to.equal(usdt(2_000n))
    expect(await ctx.aToken.balanceOf(ctx.lp2.address)).to.equal(usdt(2_000n))
    expect(await ctx.aToken.balanceOf(vaultAddr)).to.equal(0n)
  })

  it('keeps redeemers whole when Aave is healthy, and blocks aToken sweeps', async function () {
    const { ctx, redeemId } = await strandedVault()
    await armEmergencyExit(ctx)

    // Healthy Aave: full recall, pure-underlying payout, no yield leg.
    await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId)).to.not.emit(
      ctx.vault,
      'RedeemYieldSettled'
    )
    const before = await ctx.settlement.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.equal(usdt(2_000n))

    // The yield token backs emergency claims, so the guardian cannot sweep it.
    await expect(
      ctx.vault.connect(ctx.guardian).sweepToken(await ctx.aToken.getAddress(), ctx.other.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
  })
})
