import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  DAY,
  cngn,
  deployOperatorVault,
  usdt,
} from './fixtures/operatorVault.fixture'
import {
  armEmergencyExit,
  closeAndProcessDeposit,
  closeRedeem,
  pullFromVault,
  seedShares,
} from './helpers/vaultLifecycle'
import { freshAttestation, attestationSignatures } from './helpers/vaultSignatures'

/** 0.0006 USDT per cNGN, WAD-scaled. cngn(1_000_000) is worth usdt(600). */
const PRICE_CNGN = 6n * 10n ** 14n
/** `corridor.balanceOf(vault)` must always equal pending + reserved + free. */
async function expectCorridorBooksBalance(
  ctx: Awaited<ReturnType<typeof deployOperatorVault>>
) {
  const vault = await ctx.vault.getAddress()
  const [balance, pending, reserved, free] = await Promise.all([
    ctx.corridor.balanceOf(vault),
    ctx.vault.pendingCorridor(),
    ctx.vault.reservedCorridor(),
    ctx.vault.freeCorridor(),
  ])
  expect(balance).to.equal(pending + reserved + free)
}

describe('OperatorVault — corridor deposits', function () {
  it('queues corridor in its own epoch, outside free inventory, and refunds on cancel', async function () {
    const ctx = await deployOperatorVault()
    const amount = cngn(1_000_000n)
    const before = await ctx.corridor.balanceOf(ctx.lp1.address)

    await expect(
      ctx.vault
        .connect(ctx.lp1)
        .requestDepositCorridor(amount, ctx.lp1.address, ctx.lp1.address)
    )
      .to.emit(ctx.vault, 'DepositRequest')
      .withArgs(
        ctx.lp1.address,
        ctx.lp1.address,
        1n,
        ctx.lp1.address,
        amount,
        true
      )

    const id = await ctx.vault.currentCorridorDepositEpochId()
    expect(id).to.equal(1n)
    expect(await ctx.vault.currentDepositEpochId()).to.equal(0n)
    const epoch = await ctx.vault.epochs(id)
    expect(epoch.isDeposit).to.equal(true)
    expect(epoch.inCorridor).to.equal(true)
    expect(epoch.units).to.equal(amount)
    expect(await ctx.vault.requestUnits(ctx.lp1.address, id)).to.equal(amount)

    expect(await ctx.vault.pendingCorridor()).to.equal(amount)
    expect(await ctx.vault.pendingSettlement()).to.equal(0n)
    expect(await ctx.vault.freeCorridor()).to.equal(0n)
    expect(await ctx.vault.quotableCorridor()).to.equal(0n)
    await expectCorridorBooksBalance(ctx)

    await expect(ctx.vault.connect(ctx.lp1).cancelDeposit(id, ctx.lp1.address))
      .to.emit(ctx.vault, 'DepositCancelled')
      .withArgs(ctx.lp1.address, id, amount)
    expect(await ctx.vault.pendingCorridor()).to.equal(0n)
    expect(await ctx.corridor.balanceOf(ctx.lp1.address)).to.equal(before)
  })

  it('keeps settlement and corridor deposits in separate epochs', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault
      .connect(ctx.lp1)
      .requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    await ctx.vault
      .connect(ctx.lp2)
      .requestDepositCorridor(cngn(1_000n), ctx.lp2.address, ctx.lp2.address)
    const settlementId = await ctx.vault.currentDepositEpochId()
    const corridorId = await ctx.vault.currentCorridorDepositEpochId()
    expect(settlementId).to.equal(1n)
    expect(corridorId).to.equal(2n)
    expect((await ctx.vault.epochs(settlementId)).inCorridor).to.equal(false)
    expect((await ctx.vault.epochs(corridorId)).inCorridor).to.equal(true)

    // A second corridor deposit joins the open corridor epoch, not the settlement one.
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(cngn(500n), ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.currentCorridorDepositEpochId()).to.equal(corridorId)
    expect((await ctx.vault.epochs(corridorId)).units).to.equal(cngn(1_500n))
    expect((await ctx.vault.epochs(settlementId)).units).to.equal(usdt(1_000n))

    // Closing one stream leaves the other's pointer alone.
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(corridorId)
    expect(await ctx.vault.currentCorridorDepositEpochId()).to.equal(0n)
    expect(await ctx.vault.currentDepositEpochId()).to.equal(settlementId)
    await ctx.vault.closeDepositEpoch(settlementId)
    expect(await ctx.vault.currentDepositEpochId()).to.equal(0n)
  })

  it('mints shares at the attested corridor price', async function () {
    const ctx = await deployOperatorVault()
    const amount = cngn(1_000_000n)
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(amount, ctx.lp1.address, ctx.lp1.address)
    const id = await ctx.vault.currentCorridorDepositEpochId()

    await expect(closeAndProcessDeposit(ctx, id, PRICE_CNGN)).to.not.be.reverted
    const epoch = await ctx.vault.epochs(id)
    expect(epoch.state).to.equal(3) // Processed
    expect(epoch.shares).to.equal(usdt(600n))

    // Released into inventory only once priced: NAV now carries it.
    expect(await ctx.vault.pendingCorridor()).to.equal(0n)
    expect(await ctx.vault.freeCorridor()).to.equal(amount)
    expect(await ctx.vault.lastSettledNav()).to.equal(usdt(600n))
    await expectCorridorBooksBalance(ctx)

    await ctx.vault.connect(ctx.lp1).claim(id, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.balanceOf(ctx.lp1.address)).to.equal(usdt(600n))
    expect(await ctx.vault.totalSupply()).to.equal(usdt(600n))
  })

  it('gives equal value in either asset the same number of shares', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault
      .connect(ctx.lp1)
      .requestDeposit(usdt(600n), ctx.lp1.address, ctx.lp1.address)
    await ctx.vault
      .connect(ctx.lp2)
      .requestDepositCorridor(
        cngn(1_000_000n),
        ctx.lp2.address,
        ctx.lp2.address
      )
    const settlementId = await ctx.vault.currentDepositEpochId()
    const corridorId = await ctx.vault.currentCorridorDepositEpochId()

    await closeAndProcessDeposit(ctx, settlementId, PRICE_CNGN)
    // Same window, fresh attestation: lastSettledNav moved when the first epoch processed.
    await time.increase(1)
    await ctx.vault.closeDepositEpoch(corridorId)
    const att = await freshAttestation(ctx.vault, corridorId, PRICE_CNGN)
    expect(att.nav).to.equal(usdt(600n)) // pending corridor is not in NAV yet
    await ctx.vault.processDepositEpoch(
      corridorId,
      att,
      ...(await attestationSignatures(ctx, att))
    )

    await ctx.vault
      .connect(ctx.lp1)
      .claim(settlementId, ctx.lp1.address, ctx.lp1.address)
    await ctx.vault
      .connect(ctx.lp2)
      .claim(corridorId, ctx.lp2.address, ctx.lp2.address)
    expect(await ctx.vault.balanceOf(ctx.lp1.address)).to.equal(usdt(600n))
    expect(await ctx.vault.balanceOf(ctx.lp2.address)).to.equal(usdt(600n))
    expect(await ctx.vault.lastSettledNav()).to.equal(usdt(1_200n))
  })

  it('gives two depositors in one corridor epoch the same price, last claimer taking the residue', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(cngn(100_000n), ctx.lp1.address, ctx.lp1.address)
    await ctx.vault
      .connect(ctx.lp2)
      .requestDepositCorridor(cngn(300_000n), ctx.lp2.address, ctx.lp2.address)
    const id = await ctx.vault.currentCorridorDepositEpochId()
    await closeAndProcessDeposit(ctx, id, PRICE_CNGN)
    await ctx.vault.connect(ctx.lp1).claim(id, ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).claim(id, ctx.lp2.address, ctx.lp2.address)
    expect(await ctx.vault.balanceOf(ctx.lp1.address)).to.equal(usdt(60n))
    expect(await ctx.vault.balanceOf(ctx.lp2.address)).to.equal(usdt(180n))
    expect(await ctx.vault.balanceOf(await ctx.vault.getAddress())).to.equal(0n)
  })

  it('never lets pending corridor into NAV, quotes, or a redemption payout', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    const pending = cngn(500_000n)
    await ctx.vault
      .connect(ctx.lp2)
      .requestDepositCorridor(pending, ctx.lp2.address, ctx.lp2.address)
    const corridorId = await ctx.vault.currentCorridorDepositEpochId()
    expect(await ctx.vault.freeCorridor()).to.equal(0n)
    expect(await ctx.vault.quotableCorridor()).to.equal(0n)

    // Full-supply exit, paid live under pause: pending corridor is not free
    // inventory, so the redeemer takes the settlement and none of the queue.
    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await closeRedeem(ctx)
    await ctx.vault.connect(ctx.guardian).pause()
    const att = await freshAttestation(ctx.vault, redeemId, PRICE_CNGN)
    expect(att.freeCorridor).to.equal(0n)
    expect(att.nav).to.equal(usdt(1_000n))
    await expect(
      ctx.vault.settleRedeemEpoch(
        redeemId,
        att,
        ...(await attestationSignatures(ctx, att))
      )
    )
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(redeemId, usdt(1_000n), usdt(1_000n), 0n)
    await ctx.vault
      .connect(ctx.lp1)
      .claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.vault.epochs(redeemId)).remainingCorridor).to.equal(0n)
    await ctx.vault.connect(ctx.guardian).unpause()

    // The queued deposit is untouched, and prices into the now-empty book on
    // its own attestation: NAV is zero after the exit, so it takes the whole vault.
    expect(await ctx.vault.pendingCorridor()).to.equal(pending)
    await expectCorridorBooksBalance(ctx)
    await ctx.vault.closeDepositEpoch(corridorId)
    const depositAtt = await freshAttestation(ctx.vault, corridorId, PRICE_CNGN)
    expect(depositAtt.nav).to.equal(0n)
    await ctx.vault.processDepositEpoch(
      corridorId,
      depositAtt,
      ...(await attestationSignatures(ctx, depositAtt))
    )
    await ctx.vault
      .connect(ctx.lp2)
      .claim(corridorId, ctx.lp2.address, ctx.lp2.address)
    expect(await ctx.vault.pendingCorridor()).to.equal(0n)
    expect(await ctx.vault.balanceOf(ctx.lp2.address)).to.equal(usdt(300n))
    expect(await ctx.vault.totalSupply()).to.equal(usdt(300n))
    expect(await ctx.vault.freeCorridor()).to.equal(pending)
  })

  it('leaves pending corridor out of an emergency in-kind exit', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    const pending = cngn(500_000n)
    await ctx.vault
      .connect(ctx.lp2)
      .requestDepositCorridor(pending, ctx.lp2.address, ctx.lp2.address)
    const corridorId = await ctx.vault.currentCorridorDepositEpochId()

    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await closeRedeem(ctx)
    await armEmergencyExit(ctx)
    await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(redeemId, usdt(1_000n), usdt(1_000n), 0n)
    expect(await ctx.vault.pendingCorridor()).to.equal(pending)
    expect((await ctx.vault.epochs(corridorId)).units).to.equal(pending)
  })

  it('refunds corridor at face value when the valuation times out', async function () {
    const ctx = await deployOperatorVault()
    const amount = cngn(2_000n)
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(amount, ctx.lp1.address, ctx.lp1.address)
    const id = await ctx.vault.currentCorridorDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(id)
    await time.increase(DAY)
    await ctx.vault.voidDepositEpoch(id)

    const before = await ctx.corridor.balanceOf(ctx.lp1.address)
    await expect(
      ctx.vault.connect(ctx.lp1).claim(id, ctx.lp1.address, ctx.lp1.address)
    )
      .to.emit(ctx.vault, 'Claimed')
      .withArgs(ctx.lp1.address, ctx.lp1.address, id, 0n, 0n, amount)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - before).to.equal(
      amount
    )
    expect(await ctx.vault.pendingCorridor()).to.equal(0n)
    expect(await ctx.vault.pendingSettlement()).to.equal(0n)
  })

  it('enforces the corridor minimum, the pause, and the per-vault switch', async function () {
    const ctx = await deployOperatorVault()
    await expect(
      ctx.vault
        .connect(ctx.lp1)
        .requestDepositCorridor(cngn(1n), ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    await expect(
      ctx.vault
        .connect(ctx.other)
        .requestDepositCorridor(cngn(100n), ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'NotAuthorized')
    await ctx.vault.connect(ctx.guardian).pause()
    await expect(
      ctx.vault
        .connect(ctx.lp1)
        .requestDepositCorridor(cngn(100n), ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'EnforcedPause')

    const off = await deployOperatorVault({ minDepositCorridor: 0n })
    expect(await off.vault.minDepositCorridor()).to.equal(0n)
    await expect(
      off.vault
        .connect(off.lp1)
        .requestDepositCorridor(cngn(1_000n), off.lp1.address, off.lp1.address)
    ).to.be.revertedWithCustomError(off.vault, 'CorridorDepositsDisabled')
    await expect(
      off.vault
        .connect(off.lp1)
        .requestDeposit(usdt(1_000n), off.lp1.address, off.lp1.address)
    ).to.not.be.reverted
  })

  it('rejects processing after free corridor is pulled below the attested floor', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(
        cngn(1_000_000n),
        ctx.lp1.address,
        ctx.lp1.address
      )
    const firstId = await ctx.vault.currentCorridorDepositEpochId()
    await closeAndProcessDeposit(ctx, firstId, PRICE_CNGN)
    await ctx.vault
      .connect(ctx.lp1)
      .claim(firstId, ctx.lp1.address, ctx.lp1.address)

    await ctx.vault
      .connect(ctx.lp2)
      .requestDepositCorridor(
        cngn(1_000_000n),
        ctx.lp2.address,
        ctx.lp2.address
      )
    const second = await ctx.vault.currentCorridorDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(second)
    const att = await freshAttestation(ctx.vault, second, PRICE_CNGN)
    const sigs = await attestationSignatures(ctx, att)

    await pullFromVault(ctx, ctx.corridor, ctx.lp2.address, cngn(1n))
    await expect(
      ctx.vault.processDepositEpoch(second, att, ...sigs)
    ).to.be.revertedWithCustomError(ctx.vault, 'InconsistentNav')

    // A donation above the floor is fine, and the epoch still mints against the signed NAV.
    await ctx.corridor.mint(await ctx.vault.getAddress(), cngn(10n))
    await ctx.vault.processDepositEpoch(second, att, ...sigs)
    expect((await ctx.vault.epochs(second)).shares).to.equal(usdt(600n))
  })

  it('bricks an epoch whose value rounds to zero until it is voided', async function () {
    const ctx = await deployOperatorVault({ minDepositCorridor: 1n })
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(1n, ctx.lp1.address, ctx.lp1.address)
    const id = await ctx.vault.currentCorridorDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(id)
    const att = await freshAttestation(ctx.vault, id, PRICE_CNGN)
    await expect(
      ctx.vault.processDepositEpoch(
        id,
        att,
        ...(await attestationSignatures(ctx, att))
      )
    ).to.be.revertedWithCustomError(ctx.vault, 'ZeroAmount')
    await time.increase(DAY)
    await ctx.vault.voidDepositEpoch(id)
    await ctx.vault.connect(ctx.lp1).claim(id, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.pendingCorridor()).to.equal(0n)
  })

  it('pays a corridor-funded book back in kind on redemption', async function () {
    const ctx = await deployOperatorVault()
    const amount = cngn(1_000_000n)
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(amount, ctx.lp1.address, ctx.lp1.address)
    const depositId = await ctx.vault.currentCorridorDepositEpochId()
    await closeAndProcessDeposit(ctx, depositId, PRICE_CNGN)
    await ctx.vault
      .connect(ctx.lp1)
      .claim(depositId, ctx.lp1.address, ctx.lp1.address)

    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(600n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await closeRedeem(ctx)
    // Full-supply exit: refused while ERC-1271 is live, then paid live under
    // pause so the whole corridor book goes back and nothing is stranded.
    const live = await freshAttestation(ctx.vault, redeemId, PRICE_CNGN)
    await expect(
      ctx.vault.settleRedeemEpoch(
        redeemId,
        live,
        ...(await attestationSignatures(ctx, live))
      )
    ).to.be.revertedWithCustomError(ctx.vault, 'PauseRequired')

    await ctx.vault.connect(ctx.guardian).pause()
    const att = await freshAttestation(ctx.vault, redeemId, PRICE_CNGN)
    await expect(
      ctx.vault.settleRedeemEpoch(
        redeemId,
        att,
        ...(await attestationSignatures(ctx, att))
      )
    )
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(redeemId, usdt(600n), 0n, amount)
    const before = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault
      .connect(ctx.lp1)
      .claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - before).to.equal(
      amount
    )
    await expectCorridorBooksBalance(ctx)
  })
})
