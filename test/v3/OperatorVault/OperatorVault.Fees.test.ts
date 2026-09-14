import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { DAY, PRICE_1, WAD, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import type { DeployedVault } from './fixtures/operatorVault.fixture'
import { closeAndSettleRedeem, seedShares } from './helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from './helpers/vaultSignatures'

describe('OperatorVault — management fee', function () {
  it('checkpoints the fee before a paused full-supply settle', async function () {
    const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
    await seedShares(ctx, ctx.lp1)

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(redeemId)
    await ctx.vault.connect(ctx.guardian).pause()
    await time.increase(365 * DAY)
    const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    await ctx.vault.settleRedeemEpoch(redeemId, att, sig)

    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.be.gt(0)
  })

  it('checkpoints accrued fees to the old recipient before a change', async function () {
    const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
    await seedShares(ctx, ctx.lp1)
    await time.increase(365 * DAY)
    await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.be.gt(0)
    expect(await ctx.vault.balanceOf(ctx.other.address)).to.equal(0)
  })

  it('does not mint fee shares when the rate is zero', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(0)
  })

  // The wind-down the two BSC gen3 vaults hit: the last LP exits and the fee's
  // dilution is left owning the vault, under the floor, with no way out.
  describe('the fee recipient can always exit its own dilution', function () {
    /** Wind the vault down to nothing but the fee recipient's own dilution. */
    async function windDown(): Promise<DeployedVault> {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 100n })
      await seedShares(ctx, ctx.lp1)

      const lpShares = await ctx.vault.balanceOf(ctx.lp1.address)
      await ctx.vault.connect(ctx.lp1).requestRedeem(lpShares, ctx.lp1.address, ctx.lp1.address)
      const redeemId = await ctx.vault.currentRedeemEpochId()
      await closeAndSettleRedeem(ctx, redeemId)
      await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
      return ctx
    }

    it('leaves the fee holding the whole supply, under the floor', async function () {
      const ctx = await windDown()
      const feeShares = await ctx.vault.balanceOf(ctx.feeRecipient.address)

      expect(feeShares).to.be.gt(0)
      expect(feeShares).to.equal(await ctx.vault.totalSupply())
      expect(feeShares).to.be.lt(await ctx.vault.minRedeemShares())
      expect(await ctx.vault.freeSettlement()).to.be.gt(0)
    })

    /** Request, settle, claim the fee recipient's whole balance. Returns what
     *  is still in the vault after. Assumes the vault is already paused. */
    async function exitFee(ctx: DeployedVault): Promise<bigint> {
      const fee = ctx.feeRecipient
      const held = await ctx.vault.balanceOf(fee.address)
      await ctx.vault.connect(fee).requestRedeem(held, fee.address, fee.address)
      const feeId = await ctx.vault.currentRedeemEpochId()
      await closeAndSettleRedeem(ctx, feeId)
      await ctx.vault.connect(fee).claim(feeId, fee.address, fee.address)
      return ctx.vault.freeSettlement()
    }

    // Exact only because the settle-time checkpoint rounds to zero at this
    // size, so the queued shares really are the whole supply. The totalSupply
    // assertion pins that premise — see the convergence test below for what
    // happens when the checkpoint does mint.
    it('is paid every asset behind it once the guardian pauses', async function () {
      const ctx = await windDown()
      const fee = ctx.feeRecipient
      const stranded = await ctx.vault.freeSettlement()
      const before = await ctx.settlement.balanceOf(fee.address)

      await ctx.vault.connect(ctx.guardian).pause()
      expect(await exitFee(ctx)).to.equal(0)

      expect((await ctx.settlement.balanceOf(fee.address)) - before).to.equal(stranded)
      expect(await ctx.vault.totalSupply()).to.equal(0)
    })

    /**
     * Big enough that the settle-time checkpoint mints, so the queued shares
     * are no longer the whole supply and the exit pays pro rata. What is left
     * is the fee earned during the exit epoch itself — a new below-floor tail,
     * redeemable on the same exemption. So the exit converges instead of
     * completing in one pass, and nothing ever locks.
     */
    it('converges when the exit epoch accrues a new tail', async function () {
      const ctx = await deployOperatorVault({
        managementFeeWad: WAD / 10n,
        minRedeemShares: usdt(200_000n),
      })
      await seedShares(ctx, ctx.lp1, usdt(1_000_000n))
      await time.increase(365 * DAY)

      const lpShares = await ctx.vault.balanceOf(ctx.lp1.address)
      await ctx.vault.connect(ctx.lp1).requestRedeem(lpShares, ctx.lp1.address, ctx.lp1.address)
      const lpId = await ctx.vault.currentRedeemEpochId()
      await closeAndSettleRedeem(ctx, lpId)
      await ctx.vault.connect(ctx.lp1).claim(lpId, ctx.lp1.address, ctx.lp1.address)

      const stranded = await ctx.vault.freeSettlement()
      expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.be.lt(
        await ctx.vault.minRedeemShares()
      )

      await ctx.vault.connect(ctx.guardian).pause()
      const afterFirst = await exitFee(ctx)
      const afterSecond = await exitFee(ctx)

      // One pass is not the end, but it is almost all of it.
      expect(afterFirst).to.be.gt(0)
      expect(afterFirst).to.be.lt(stranded / 1_000n)
      // And each further pass takes the same bite out of what is left.
      expect(afterSecond).to.be.lt(afterFirst / 100n)
    })

    // The settle-time checkpoint rounds to zero on a position this small, so
    // `shares == supply` holds. The floor is lifted; this guard is not.
    it('still needs the pause to take the last share', async function () {
      const ctx = await windDown()
      const fee = ctx.feeRecipient
      const feeShares = await ctx.vault.balanceOf(fee.address)

      await ctx.vault.connect(fee).requestRedeem(feeShares, fee.address, fee.address)
      const feeId = await ctx.vault.currentRedeemEpochId()
      await expect(closeAndSettleRedeem(ctx, feeId)).to.be.revertedWithCustomError(
        ctx.vault,
        'PauseRequired'
      )
    })

    it('still refuses zero, from the fee recipient like anyone else', async function () {
      const ctx = await windDown()
      const fee = ctx.feeRecipient
      await expect(
        ctx.vault.connect(fee).requestRedeem(0n, fee.address, fee.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })

    it('does not lift the floor for an ordinary LP', async function () {
      const ctx = await windDown()
      await seedShares(ctx, ctx.lp2)
      await expect(
        ctx.vault.connect(ctx.lp2).requestRedeem(usdt(1n), ctx.lp2.address, ctx.lp2.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })

    it('does not lift the floor for the old recipient after a change', async function () {
      const ctx = await windDown()
      const old = ctx.feeRecipient
      const held = await ctx.vault.balanceOf(old.address)
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)

      await expect(
        ctx.vault.connect(old).requestRedeem(held, old.address, old.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })
  })
})
