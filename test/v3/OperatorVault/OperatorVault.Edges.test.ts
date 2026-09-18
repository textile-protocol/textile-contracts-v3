import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { DAY, PRICE_1, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { closeAndProcessDeposit, closeRedeem, seedShares } from './helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from './helpers/vaultSignatures'

describe('OperatorVault — remaining edges', function () {
  it('opens a fresh deposit epoch once the current one is past cutoff', async function () {
    const { vault, lp1 } = await deployOperatorVault()
    await vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
    const first = await vault.currentDepositEpochId()
    await time.increase(DAY)
    // Deposits are never transiently bricked between cutoff and close: a
    // request past cutoff starts the next epoch (audit §6 improvement 6).
    await vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
    const second = await vault.currentDepositEpochId()
    expect(second).to.equal(first + 1n)
    expect((await vault.epochs(second)).assets).to.equal(usdt(100n))
    // The past-cutoff epoch is unaffected and closes as usual.
    await vault.closeDepositEpoch(first)
    expect((await vault.epochs(first)).state).to.equal(2) // Closed
    expect((await vault.epochs(first)).assets).to.equal(usdt(100n))
  })

  it('processes an empty deposit epoch after every request is cancelled', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentDepositEpochId()
    await ctx.vault.connect(ctx.lp1).cancelDeposit(epochId, ctx.lp1.address)
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.processDepositEpoch(epochId, att, sig)
    expect((await ctx.vault.epochs(epochId)).state).to.equal(3) // Processed
  })

  it('lets a spender redeem with allowance and tracks the request through settlement', async function () {
    const ctx = await deployOperatorVault()
    const { depositId } = await seedShares(ctx, ctx.lp1)

    await ctx.vault.connect(ctx.lp1).approve(ctx.lp2.address, usdt(200n))
    await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(200n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    expect(await ctx.vault.requestUnits(ctx.lp1.address, redeemId)).to.equal(usdt(200n))
    expect((await ctx.vault.epochs(redeemId)).state).to.equal(1) // Open: pending, not claimable
    expect(await ctx.vault.requestUnits(ctx.lp1.address, depositId)).to.equal(0) // claimed
    expect(await ctx.vault.requestClaimed(ctx.lp1.address, depositId)).to.equal(true)

    await expect(
      ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'EpochNotClaimable')

    await closeRedeem(ctx, redeemId)
    const ratt = await freshAttestation(ctx.vault, redeemId, PRICE_1)
    const rsig = await signAttestation(ctx.harness, ctx.risk, ratt)
    await ctx.vault.settleRedeemEpoch(redeemId, ratt, rsig)
    expect(await ctx.vault.requestUnits(ctx.lp1.address, redeemId)).to.equal(usdt(200n))
    expect((await ctx.vault.epochs(redeemId)).state).to.equal(5) // Settled: claimable
  })

  it('rejects a spender redeem without allowance', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    await expect(
      ctx.vault.connect(ctx.lp2).requestRedeem(usdt(200n), ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'NotAuthorized')
  })

  it('rejects claim and cancel with a zero receiver or missing request', async function () {
    const { vault, lp1 } = await deployOperatorVault()
    await vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
    await expect(vault.connect(lp1).claim(1n, lp1.address, ethers.ZeroAddress)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
    await expect(vault.connect(lp1).claim(1n, ethers.ZeroAddress, lp1.address)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
    await expect(vault.connect(lp1).cancelDeposit(1n, lp1.address)).to.not.be.reverted
    await expect(vault.connect(lp1).cancelDeposit(1n, lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NothingToClaim'
    )
  })

  it('rejects cancel after the deposit epoch is closed', async function () {
    const { vault, lp1 } = await deployOperatorVault()
    await vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
    await time.increase(DAY)
    await vault.closeDepositEpoch(1n)
    await expect(vault.connect(lp1).cancelDeposit(1n, lp1.address)).to.be.revertedWithCustomError(
      vault,
      'EpochNotOpen'
    )
  })

  it('rejects epoch lifecycle calls in the wrong state', async function () {
    const ctx = await deployOperatorVault()
    await expect(ctx.vault.closeDepositEpoch(1n)).to.be.revertedWithCustomError(
      ctx.vault,
      'EpochNotOpen'
    )
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const depositId = await ctx.vault.currentDepositEpochId()
    await expect(ctx.vault.closeDepositEpoch(depositId)).to.be.revertedWithCustomError(
      ctx.vault,
      'EpochNotReady'
    )
    const att = await freshAttestation(ctx.vault, depositId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.processDepositEpoch(depositId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'EpochNotClosed'
    )
    await expect(ctx.vault.voidDepositEpoch(depositId)).to.be.revertedWithCustomError(
      ctx.vault,
      'EpochNotClosed'
    )

    await seedShares(ctx, ctx.lp1, usdt(500n))
    await expect(
      ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1n), ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await expect(ctx.vault.closeRedeemEpoch(redeemId)).to.be.revertedWithCustomError(
      ctx.vault,
      'EpochNotReady'
    )
    await expect(ctx.vault.closeRedeemEpoch(depositId)).to.be.revertedWithCustomError(
      ctx.vault,
      'EpochNotOpen'
    )
    await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'EpochNotClosed'
    )
  })

  it('requires the pause for a full-supply exit that still holds corridor, then pays it out', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    const corridorHeld = 10n ** 18n
    await ctx.corridor.mint(await ctx.vault.getAddress(), corridorHeld)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, redeemId)
    const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'PauseRequired'
    )
    await ctx.vault.connect(ctx.guardian).pause()
    await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(redeemId, usdt(1_000n), usdt(1_000n), corridorHeld)
    const before = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - before).to.equal(corridorHeld)
    expect(await ctx.vault.freeCorridor()).to.equal(0n)
  })

  it('pays pro rata when free settlement alone could not cover the epoch NAV', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    // 1,000 cNGN at PRICE_1 doubles NAV: 600 shares are worth 1,200 in
    // settlement, more than the 1,000 held. Pro rata sidesteps the shortfall
    // by paying 60% of each leg instead of converting one into the other.
    const corridorHeld = 10n ** 21n
    await ctx.corridor.mint(await ctx.vault.getAddress(), corridorHeld)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(600n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, redeemId)
    const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .withArgs(redeemId, usdt(600n), usdt(600n), (corridorHeld * 6n) / 10n)
    const beforeS = await ctx.settlement.balanceOf(ctx.lp1.address)
    const beforeC = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - beforeS).to.equal(usdt(600n))
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - beforeC).to.equal((corridorHeld * 6n) / 10n)
    expect(await ctx.vault.freeSettlement()).to.equal(usdt(400n))
    expect(await ctx.vault.freeCorridor()).to.equal((corridorHeld * 4n) / 10n)
  })

  it('reverts a deposit that would mint zero shares against a huge NAV', async function () {
    const ctx = await deployOperatorVault({ minDepositAssets: 1n })
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.corridor.mint(await ctx.vault.getAddress(), 10n ** 36n)
    await ctx.vault.connect(ctx.lp2).requestDeposit(1n, ctx.lp2.address, ctx.lp2.address)
    const epochId = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.processDepositEpoch(epochId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'ZeroAmount'
    )
  })

  it('subtracts min reserves from quotable inventory, not from NAV', async function () {
    const ctx = await deployOperatorVault({ minReserveSettlement: usdt(400n) })
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const depositId = await closeAndProcessDeposit(ctx)
    await ctx.vault.connect(ctx.lp1).claim(depositId, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.freeSettlement()).to.equal(usdt(1_000n))
    expect(await ctx.vault.quotableSettlement()).to.equal(usdt(600n))
    expect(await ctx.vault.totalAssets()).to.equal(usdt(1_000n))
    expect(await ctx.vault.quotableCorridor()).to.equal(0)
  })

  it('rejects a stranger depositing or claiming for another owner', async function () {
    const ctx = await deployOperatorVault()
    await expect(
      ctx.vault
        .connect(ctx.other)
        .requestDeposit(usdt(100n), ctx.other.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'NotAuthorized')

    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await closeAndProcessDeposit(ctx)
    await expect(
      ctx.vault.connect(ctx.other).claim(epochId, ctx.lp1.address, ctx.other.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'NotAuthorized')
  })

  it('lets an approved operator claim for the controller', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await closeAndProcessDeposit(ctx)
    expect(await ctx.vault.connect(ctx.lp1).setOperator.staticCall(ctx.other.address, true)).to.equal(
      true
    )
    await ctx.vault.connect(ctx.lp1).setOperator(ctx.other.address, true)
    await ctx.vault.connect(ctx.other).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.balanceOf(ctx.lp1.address)).to.equal(usdt(100n))
  })

  it('keeps an open deposit request out of claim until its epoch is processed', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const depositId = await ctx.vault.currentDepositEpochId()
    expect(await ctx.vault.requestUnits(ctx.lp1.address, depositId)).to.equal(usdt(100n))
    expect(await ctx.vault.requestClaimed(ctx.lp1.address, depositId)).to.equal(false)
    await expect(
      ctx.vault.connect(ctx.lp1).claim(depositId, ctx.lp1.address, ctx.lp1.address)
    ).to.be.revertedWithCustomError(ctx.vault, 'EpochNotClaimable')
  })
})
