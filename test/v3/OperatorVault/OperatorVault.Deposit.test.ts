import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { DAY, PRICE_1, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { closeAndProcessDeposit } from './helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from './helpers/vaultSignatures'

describe('OperatorVault — deposits', function () {
  async function processOpenDeposit() {
    const ctx = await deployOperatorVault()
    const amount = usdt(1_000n)
    await ctx.vault.connect(ctx.lp1).requestDeposit(amount, ctx.lp1.address, ctx.lp1.address)
    const epochId = await closeAndProcessDeposit(ctx)
    return { ...ctx, amount, epochId }
  }

  it('queues a deposit and lets the LP cancel before cutoff', async function () {
    const { vault, settlement, lp1 } = await deployOperatorVault()
    const amount = usdt(1_000n)
    const before = await settlement.balanceOf(lp1.address)
    await vault.connect(lp1).requestDeposit(amount, lp1.address, lp1.address)
    expect(await vault.pendingSettlement()).to.equal(amount)
    expect(await vault.pendingDepositRequest(1n, lp1.address)).to.equal(amount)

    await vault.connect(lp1).cancelDeposit(1n, lp1.address)
    expect(await vault.pendingSettlement()).to.equal(0)
    expect(await settlement.balanceOf(lp1.address)).to.equal(before)
  })

  it('mints claimable shares at one price for the epoch', async function () {
    const { vault, lp1, amount, epochId } = await processOpenDeposit()
    expect(await vault.claimableDepositRequest(epochId, lp1.address)).to.equal(amount)
    await vault.connect(lp1).claim(epochId, lp1.address, lp1.address)
    expect(await vault.balanceOf(lp1.address)).to.equal(amount)
    expect(await vault.totalSupply()).to.equal(amount)
    expect(await vault.lastSettledNav()).to.equal(amount)
  })

  it('gives two depositors in the same epoch the same share price', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(3_000n), ctx.lp2.address, ctx.lp2.address)
    const epochId = await closeAndProcessDeposit(ctx)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).claim(epochId, ctx.lp2.address, ctx.lp2.address)
    expect(await ctx.vault.balanceOf(ctx.lp1.address)).to.equal(usdt(1_000n))
    expect(await ctx.vault.balanceOf(ctx.lp2.address)).to.equal(usdt(3_000n))
  })

  it('refunds at face value when the valuation times out', async function () {
    const { vault, settlement, lp1 } = await deployOperatorVault()
    const amount = usdt(500n)
    await vault.connect(lp1).requestDeposit(amount, lp1.address, lp1.address)
    const epochId = await vault.currentDepositEpochId()
    await time.increase(DAY)
    await vault.closeDepositEpoch(epochId)
    await expect(vault.voidDepositEpoch(epochId)).to.be.revertedWithCustomError(
      vault,
      'TimeoutNotReached'
    )
    await time.increase(DAY)
    await vault.voidDepositEpoch(epochId)
    const before = await settlement.balanceOf(lp1.address)
    await vault.connect(lp1).claim(epochId, lp1.address, lp1.address)
    expect((await settlement.balanceOf(lp1.address)) - before).to.equal(amount)
    expect(await vault.pendingSettlement()).to.equal(0)
  })

  it('rejects deposits below the minimum and while paused', async function () {
    const { vault, lp1, guardian } = await deployOperatorVault()
    await expect(
      vault.connect(lp1).requestDeposit(usdt(1n), lp1.address, lp1.address)
    ).to.be.revertedWithCustomError(vault, 'BelowMinSize')
    await vault.connect(guardian).pause()
    await expect(
      vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
    ).to.be.revertedWithCustomError(vault, 'EnforcedPause')
  })

  it('blocks cancel after cutoff and cancel by a stranger', async function () {
    const { vault, lp1, other } = await deployOperatorVault()
    await vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
    await expect(vault.connect(other).cancelDeposit(1n, lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
    await time.increase(DAY)
    await expect(vault.connect(lp1).cancelDeposit(1n, lp1.address)).to.be.revertedWithCustomError(
      vault,
      'CancelWindowClosed'
    )
  })

  it('reverts preview helpers', async function () {
    const { vault } = await deployOperatorVault()
    await expect(vault.previewDeposit(1)).to.be.revertedWithCustomError(vault, 'PreviewUnsupported')
    await expect(vault.previewMint(1)).to.be.revertedWithCustomError(vault, 'PreviewUnsupported')
    await expect(vault.previewWithdraw(1)).to.be.revertedWithCustomError(vault, 'PreviewUnsupported')
    await expect(vault.previewRedeem(1)).to.be.revertedWithCustomError(vault, 'PreviewUnsupported')
  })

  it('rejects a replayed or wrong-vault attestation', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(epochId)
    const bad = await freshAttestation(ctx.vault, epochId, PRICE_1)
    bad.vault = ctx.lp1.address
    const sig = await signAttestation(ctx.harness, ctx.risk, bad)
    await expect(ctx.vault.processDepositEpoch(epochId, bad, sig)).to.be.reverted
  })

  it('rejects an attestation whose NAV does not match live inventory', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    att.nav = att.nav + 1n
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(ctx.vault.processDepositEpoch(epochId, att, sig)).to.be.revertedWithCustomError(
      ctx.vault,
      'InconsistentNav'
    )
  })

  it('still processes after a surplus donation that lifts live NAV', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(epochId)
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.settlement.mint(await ctx.vault.getAddress(), 2n)
    await expect(ctx.vault.processDepositEpoch(epochId, att, sig)).to.not.be.reverted
  })

  it('rejects a stale attestation after another epoch changes lastSettledNav', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const first = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(first)
    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(100n), ctx.lp2.address, ctx.lp2.address)
    const second = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(second)

    const firstAtt = await freshAttestation(ctx.vault, first, PRICE_1)
    const staleSecond = await freshAttestation(ctx.vault, second, PRICE_1)
    await ctx.vault.processDepositEpoch(
      first,
      firstAtt,
      await signAttestation(ctx.harness, ctx.risk, firstAtt)
    )
    await expect(
      ctx.vault.processDepositEpoch(
        second,
        staleSecond,
        await signAttestation(ctx.harness, ctx.risk, staleSecond)
      )
    ).to.be.revertedWithCustomError(ctx.vault, 'InvalidAttestation')

    const freshSecond = await freshAttestation(ctx.vault, second, PRICE_1)
    await ctx.vault.processDepositEpoch(
      second,
      freshSecond,
      await signAttestation(ctx.harness, ctx.risk, freshSecond)
    )
  })

  it('mints a later deposit against the signed NAV, not unattested surplus', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const first = await closeAndProcessDeposit(ctx)
    await ctx.vault.connect(ctx.lp1).claim(first, ctx.lp1.address, ctx.lp1.address)

    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(1_000n), ctx.lp2.address, ctx.lp2.address)
    const second = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(second)
    const att = await freshAttestation(ctx.vault, second, PRICE_1)
    expect(att.nav).to.equal(usdt(1_000n))
    await ctx.settlement.mint(await ctx.vault.getAddress(), usdt(1_000n))
    await ctx.vault.processDepositEpoch(second, att, await signAttestation(ctx.harness, ctx.risk, att))
    const epoch = await ctx.vault.epochs(second)
    expect(epoch.shares).to.equal(usdt(1_000n))
  })

  it('does not mint against a mid-fill pull that stays above attested floors', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const first = await closeAndProcessDeposit(ctx)
    await ctx.vault.connect(ctx.lp1).claim(first, ctx.lp1.address, ctx.lp1.address)

    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(1_000n), ctx.lp2.address, ctx.lp2.address)
    const second = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(second)
    const att = await freshAttestation(ctx.vault, second, PRICE_1)
    const vaultAddr = await ctx.vault.getAddress()
    await ctx.settlement.mint(vaultAddr, usdt(500n))
    await ethers.provider.send('hardhat_impersonateAccount', [vaultAddr])
    await ethers.provider.send('hardhat_setBalance', [vaultAddr, '0x1000000000000000000'])
    const asVault = await ethers.getSigner(vaultAddr)
    await ctx.settlement.connect(asVault).transfer(ctx.lp2.address, usdt(200n))
    await ctx.vault.processDepositEpoch(second, att, await signAttestation(ctx.harness, ctx.risk, att))
    const epoch = await ctx.vault.epochs(second)
    expect(epoch.shares).to.equal(usdt(1_000n))
  })

  it('rejects processing after a fill-sized pull of one inventory leg', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const first = await closeAndProcessDeposit(ctx)
    await ctx.vault.connect(ctx.lp1).claim(first, ctx.lp1.address, ctx.lp1.address)
    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(1_000n), ctx.lp2.address, ctx.lp2.address)
    const second = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(second)
    const att = await freshAttestation(ctx.vault, second, PRICE_1)
    const vaultAddr = await ctx.vault.getAddress()
    await ethers.provider.send('hardhat_impersonateAccount', [vaultAddr])
    await ethers.provider.send('hardhat_setBalance', [vaultAddr, '0x1000000000000000000'])
    const asVault = await ethers.getSigner(vaultAddr)
    await ctx.settlement.connect(asVault).transfer(ctx.lp2.address, usdt(100n))
    await expect(
      ctx.vault.processDepositEpoch(second, att, await signAttestation(ctx.harness, ctx.risk, att))
    ).to.be.revertedWithCustomError(ctx.vault, 'InconsistentNav')
  })

  it('emits DepositRequest with msg.sender', async function () {
    const { vault, lp1 } = await deployOperatorVault()
    const amount = usdt(1_000n)
    await expect(vault.connect(lp1).requestDeposit(amount, lp1.address, lp1.address))
      .to.emit(vault, 'DepositRequest')
      .withArgs(lp1.address, lp1.address, 1n, lp1.address, amount)
  })

  it('rejects processing while paused and allows void+refund while paused', async function () {
    const ctx = await deployOperatorVault()
    await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const epochId = await ctx.vault.currentDepositEpochId()
    await time.increase(DAY)
    await ctx.vault.closeDepositEpoch(epochId)
    await ctx.vault.connect(ctx.guardian).pause()
    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await expect(
      ctx.vault.processDepositEpoch(epochId, att, sig)
    ).to.be.revertedWithCustomError(ctx.vault, 'EnforcedPause')
    await time.increase(DAY)
    await ctx.vault.voidDepositEpoch(epochId)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
  })

  it('rejects double claims and claims on an open epoch', async function () {
    const { vault, lp1, epochId } = await processOpenDeposit()
    await expect(vault.connect(lp1).claim(99n, lp1.address, lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NothingToClaim'
    )
    await vault.connect(lp1).claim(epochId, lp1.address, lp1.address)
    await expect(vault.connect(lp1).claim(epochId, lp1.address, lp1.address)).to.be.revertedWithCustomError(
      vault,
      'AlreadyClaimed'
    )
  })
})
