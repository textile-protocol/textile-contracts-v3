import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { nav } from '../../../constants/src/operatorVaultMath'
import { DAY, PRICE_1, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { closeAndProcessDeposit, seedShares } from './helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from './helpers/vaultSignatures'

async function seededVault() {
  const ctx = await deployOperatorVault()
  await seedShares(ctx, ctx.lp1)
  return ctx
}

describe('OperatorVault — redemptions', function () {
  it('emits RedeemRequest with msg.sender', async function () {
    const ctx = await seededVault()
    const shares = usdt(400n)
    await expect(ctx.vault.connect(ctx.lp1).requestRedeem(shares, ctx.lp1.address, ctx.lp1.address))
      .to.emit(ctx.vault, 'RedeemRequest')
      .withArgs(ctx.lp1.address, ctx.lp1.address, 2n, ctx.lp1.address, shares)
  })

  it('cash-settles a closed epoch and lets the LP claim settlement', async function () {
    const ctx = await seededVault()
    const shares = usdt(400n)
    await ctx.vault.connect(ctx.lp1).requestRedeem(shares, ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    expect(await ctx.vault.closeOnly()).to.equal(true)

    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemEpoch(epochId, att, sig)
    expect(await ctx.vault.closeOnly()).to.equal(false)

    const before = await ctx.settlement.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.equal(shares)
    expect(await ctx.vault.balanceOf(ctx.lp1.address)).to.equal(usdt(600n))
  })

  it('blocks a second close until the outstanding epoch settles and the cooldown elapses', async function () {
    const ctx = await seededVault()
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(200n), ctx.lp1.address, ctx.lp1.address)
    const first = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(first)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(200n), ctx.lp1.address, ctx.lp1.address)
    const second = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await expect(ctx.vault.closeRedeemEpoch(second)).to.be.revertedWithCustomError(
      ctx.vault,
      'RedeemEpochOutstanding'
    )

    const att = await freshAttestation(ctx.vault, first, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemEpoch(first, att, sig)
    await expect(ctx.vault.closeRedeemEpoch(second)).to.be.revertedWithCustomError(
      ctx.vault,
      'CloseCooldownActive'
    )
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(second)
  })

  it('settles in kind after the exit timeout, including while paused', async function () {
    const ctx = await seededVault()
    await ctx.corridor.mint(await ctx.vault.getAddress(), usdt(0n) + 10n ** 18n)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    await ctx.vault.connect(ctx.guardian).pause()
    const early = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const earlySig = await signAttestation(ctx.harness, ctx.risk, early)
    await expect(
      ctx.vault.settleRedeemInKind(epochId, early, earlySig)
    ).to.be.revertedWithCustomError(ctx.vault, 'TimeoutNotReached')
    await time.increase(3 * DAY)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemInKind(epochId, att, sig)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.totalSupply()).to.equal(0)
    expect(await ctx.settlement.balanceOf(ctx.lp1.address)).to.be.gt(0)
    expect(await ctx.corridor.balanceOf(ctx.lp1.address)).to.be.gt(0)
  })

  it('pays in-kind from the signed snapshot, not unattested surplus', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    const extra = 10n ** 18n
    await ctx.corridor.mint(await ctx.vault.getAddress(), extra)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    await time.increase(3 * DAY)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    await ctx.corridor.mint(await ctx.vault.getAddress(), extra)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemInKind(epochId, att, sig)
    const before = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - before).to.equal(extra / 10n)
  })

  it('rejects a full-supply in-kind exit while ERC-1271 is still live', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    await time.increase(3 * DAY)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.settleRedeemInKind(epochId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'PauseRequired'
    )
  })

  it('gives unattested surplus to the last in-kind redeemer so it is not orphaned', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    await time.increase(3 * DAY)

    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const extraS = usdt(500n)
    const extraC = 10n ** 18n
    await ctx.settlement.mint(await ctx.vault.getAddress(), extraS)
    await ctx.corridor.mint(await ctx.vault.getAddress(), extraC)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.connect(ctx.guardian).pause()
    await ctx.vault.settleRedeemInKind(epochId, att, sig)

    const beforeS = await ctx.settlement.balanceOf(ctx.lp1.address)
    const beforeC = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - beforeS).to.equal(att.freeSettlement + extraS)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - beforeC).to.equal(att.freeCorridor + extraC)
    expect(await ctx.vault.totalSupply()).to.equal(0)
    expect(await ctx.vault.lastSettledNav()).to.equal(0)
    expect(await ctx.vault.freeSettlement()).to.equal(0)
    expect(await ctx.vault.freeCorridor()).to.equal(0)

    // Empty vault, zero lastSettledNav: the next first depositor mints 1:1.
    await ctx.vault.connect(ctx.guardian).unpause()
    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(1_000n), ctx.lp2.address, ctx.lp2.address)
    const depositId = await closeAndProcessDeposit(ctx)
    await ctx.vault.connect(ctx.lp2).claim(depositId, ctx.lp2.address, ctx.lp2.address)
    expect(await ctx.vault.balanceOf(ctx.lp2.address)).to.equal(usdt(1_000n))
  })

  it('keeps remaining corridor in lastSettledNav after a partial in-kind exit', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.corridor.mint(await ctx.vault.getAddress(), 10n ** 18n)

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    let epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemEpoch(epochId, att, sig)
    const marked = await ctx.vault.lastSettledNav()
    expect(marked).to.be.gt(await ctx.vault.freeSettlement())

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(400n), ctx.lp1.address, ctx.lp1.address)
    epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    await time.increase(3 * DAY)
    const inKind = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const inKindSig = await signAttestation(ctx.harness, ctx.risk, inKind)
    await ctx.vault.settleRedeemInKind(epochId, inKind, inKindSig)
    const last = await ctx.vault.lastSettledNav()
    expect(last).to.equal(
      nav(
        await ctx.vault.freeSettlement(),
        await ctx.vault.freeCorridor(),
        PRICE_1,
        6,
        18
      )
    )
    expect(last).to.be.gt(await ctx.vault.freeSettlement())
  })

  it('accepts a redemption request while paused', async function () {
    const ctx = await seededVault()
    await ctx.vault.connect(ctx.guardian).pause()
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.pendingRedeemRequest(await ctx.vault.currentRedeemEpochId(), ctx.lp1.address)).to.equal(
      usdt(100n)
    )
  })

  it('cash-settles a full-supply epoch when leftover is zero', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemEpoch(epochId, att, sig)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.totalSupply()).to.equal(0)
    expect(await ctx.vault.lastSettledNav()).to.equal(0)
    expect(await ctx.vault.freeSettlement()).to.equal(0)
  })

  it('rejects a full-supply cash exit that would orphan surplus', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    await ctx.settlement.mint(await ctx.vault.getAddress(), usdt(50n))
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'SurplusRequiresInKind'
    )
  })

  it('rejects cash settlement while paused', async function () {
    const ctx = await seededVault()
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    await ctx.vault.connect(ctx.guardian).pause()
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'EnforcedPause'
    )
  })

  it('splits the last cash claim residue exactly', async function () {
    const ctx = await seededVault()
    await ctx.vault.connect(ctx.lp1).transfer(ctx.lp2.address, usdt(333n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(333n), ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(333n), ctx.lp2.address, ctx.lp2.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemEpoch(epochId, att, sig)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).claim(epochId, ctx.lp2.address, ctx.lp2.address)
    const epoch = await ctx.vault.epochs(epochId)
    expect(epoch.remainingSettlement).to.equal(0)
    expect(epoch.remainingUnits).to.equal(0)
    expect(await ctx.vault.reservedSettlement()).to.equal(0)
  })
})
