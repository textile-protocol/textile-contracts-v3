import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { DAY, PRICE_1, WAD, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { seedShares } from './helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from './helpers/vaultSignatures'

describe('OperatorVault — management fee', function () {
  it('checkpoints the fee before an in-kind burn while paused', async function () {
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
    await ctx.vault.settleRedeemInKind(redeemId, att, sig)

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
})
