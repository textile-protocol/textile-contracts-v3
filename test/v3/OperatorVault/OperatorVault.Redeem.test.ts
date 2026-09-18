import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { nav } from '../../../constants/src/operatorVaultMath'
import { DAY, PRICE_1, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { closeAndProcessDeposit, closeRedeem, seedShares } from './helpers/vaultLifecycle'
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

  it('settles a closed epoch and lets the LP claim their slice', async function () {
    const ctx = await seededVault()
    const shares = usdt(400n)
    await ctx.vault.connect(ctx.lp1).requestRedeem(shares, ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
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
    await closeRedeem(ctx, first)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(200n), ctx.lp1.address, ctx.lp1.address)
    const second = await ctx.vault.currentRedeemEpochId()
    // Past the duration and the grace: only the outstanding epoch blocks a
    // third party now, and it blocks the operator too.
    await time.increase(2 * DAY)
    await expect(ctx.vault.closeRedeemEpoch(second)).to.be.revertedWithCustomError(
      ctx.vault,
      'RedeemEpochOutstanding'
    )
    await expect(ctx.vault.connect(ctx.operatorAdmin).closeRedeemEpoch(second)).to.be.revertedWithCustomError(
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

  it('pays a partial epoch from the signed snapshot, not unattested surplus', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    const extra = 10n ** 18n
    await ctx.corridor.mint(await ctx.vault.getAddress(), extra)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    await ctx.corridor.mint(await ctx.vault.getAddress(), extra)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(epochId, usdt(100n), usdt(100n), extra / 10n)
    const before = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - before).to.equal(extra / 10n)
  })

  it('gives unattested surplus to the last redeemer so it is not orphaned', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)

    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const extraS = usdt(500n)
    const extraC = 10n ** 18n
    await ctx.settlement.mint(await ctx.vault.getAddress(), extraS)
    await ctx.corridor.mint(await ctx.vault.getAddress(), extraC)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.connect(ctx.guardian).pause()
    await ctx.vault.settleRedeemEpoch(epochId, att, sig)

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

  it('keeps remaining corridor in lastSettledNav after a partial exit', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.corridor.mint(await ctx.vault.getAddress(), 10n ** 18n)

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    let epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemEpoch(epochId, att, sig)
    const marked = await ctx.vault.lastSettledNav()
    expect(marked).to.be.gt(await ctx.vault.freeSettlement())

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(400n), ctx.lp1.address, ctx.lp1.address)
    epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
    const second = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const secondSig = await signAttestation(ctx.harness, ctx.risk, second)
    await ctx.vault.settleRedeemEpoch(epochId, second, secondSig)
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
    expect(await ctx.vault.requestUnits(ctx.lp1.address, await ctx.vault.currentRedeemEpochId())).to.equal(
      usdt(100n)
    )
  })

  it('requires the pause for a full-supply exit even with zero leftover, then empties the book', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'PauseRequired'
    )
    await ctx.vault.connect(ctx.guardian).pause()
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(epochId, usdt(1_000n), usdt(1_000n), 0n)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.totalSupply()).to.equal(0)
    expect(await ctx.vault.lastSettledNav()).to.equal(0)
    expect(await ctx.vault.freeSettlement()).to.equal(0)
  })

  it('does not pay unattested settlement surplus to a partial epoch', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(500n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    await ctx.settlement.mint(await ctx.vault.getAddress(), usdt(50n))
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    // Half the supply takes half the attested floor; the 50 minted after the
    // snapshot stays with the remaining holders.
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(epochId, usdt(500n), usdt(500n), 0n)
    const before = await ctx.settlement.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.equal(usdt(500n))
    expect(await ctx.vault.freeSettlement()).to.equal(usdt(550n))
  })

  it('settles a partial epoch while paused off live balances, not the attested floor', async function () {
    const ctx = await seededVault()
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
    await ctx.vault.connect(ctx.guardian).pause()
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    // ERC-1271 is dead once paused, so live is safe to use as the floor: a
    // tenth of the supply takes a tenth of the 1,050 actually in the vault.
    await ctx.settlement.mint(await ctx.vault.getAddress(), usdt(50n))
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(epochId, usdt(100n), usdt(105n), 0n)
    const before = await ctx.settlement.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.equal(usdt(105n))
  })

  it('pays a partial epoch on a mixed book exactly pro rata and leaves the other LP whole', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await seedShares(ctx, ctx.lp2, usdt(1_000n))
    const inventoryC = 500n * 10n ** 18n
    await ctx.corridor.mint(await ctx.vault.getAddress(), inventoryC)

    const shares = usdt(500n)
    await ctx.vault.connect(ctx.lp1).requestRedeem(shares, ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
    const supply = await ctx.vault.totalSupply()
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    expect(att.freeSettlement).to.equal(usdt(2_000n))
    expect(att.freeCorridor).to.equal(inventoryC)

    // A quarter of the supply takes a quarter of each attested leg, priced by
    // nothing: the corridor price never enters the payout.
    const lp2Shares = await ctx.vault.balanceOf(ctx.lp2.address)
    const lp2ValueBefore = (att.nav * lp2Shares) / supply
    const expectedS = (att.freeSettlement * shares) / supply
    const expectedC = (att.freeCorridor * shares) / supply
    await expect(ctx.vault.settleRedeemEpoch(epochId, att, sig))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(epochId, shares, expectedS, expectedC)
    expect(expectedS).to.equal(usdt(500n))
    expect(expectedC).to.equal(inventoryC / 4n)

    const beforeS = await ctx.settlement.balanceOf(ctx.lp1.address)
    const beforeC = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - beforeS).to.equal(expectedS)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - beforeC).to.equal(expectedC)

    // lp2 holds the same shares of a book that shrank by exactly what left it.
    const lastSettledNav = await ctx.vault.lastSettledNav()
    expect(lastSettledNav).to.equal(
      nav(await ctx.vault.freeSettlement(), await ctx.vault.freeCorridor(), PRICE_1, 6, 18)
    )
    expect((lastSettledNav * lp2Shares) / (await ctx.vault.totalSupply())).to.equal(lp2ValueBefore)
  })

  it('splits the last claim residue exactly', async function () {
    const ctx = await seededVault()
    await ctx.vault.connect(ctx.lp1).transfer(ctx.lp2.address, usdt(333n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(333n), ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(333n), ctx.lp2.address, ctx.lp2.address)
    const epochId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, epochId)
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
