import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { DAY, deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import { closeRedeem, seedShares } from '../helpers/vaultLifecycle'

// v0.2 M-01: the emergency exit used to require a guardian pause, so an
// operator whose risk signer, guardian and admin all went silent locked every
// converted share forever. The timeout now pauses the vault itself.
describe('audit v0.2 M-01 — emergency exit no longer needs the guardian', function () {
  it('unwinds a full-supply redeem with every operator key silent', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    const supply = await ctx.vault.totalSupply()
    await ctx.vault.connect(ctx.lp1).requestRedeem(supply, ctx.lp1.address, ctx.lp1.address)
    const epochId = await closeRedeem(ctx)
    await time.increase(365 * DAY)

    await expect(ctx.vault.connect(ctx.other).settleRedeemEmergencyInKind(epochId))
      .to.emit(ctx.vault, 'Paused')
      .withArgs(ctx.other.address)
      .and.to.emit(ctx.vault, 'RedeemEpochSettled')
    expect(await ctx.vault.paused()).to.equal(true)
    expect(await ctx.vault.closeOnly()).to.equal(false)

    const before = await ctx.settlement.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.equal(usdt(1_000n))
    expect(await ctx.vault.totalSupply()).to.equal(0)
  })

  it('keeps unwinding later epochs through the same paused path', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(300n), ctx.lp1.address, ctx.lp1.address)
    const first = await closeRedeem(ctx)
    const timeout = await ctx.vault.emergencyExitTimeout()
    await time.increase(timeout)
    await ctx.vault.connect(ctx.other).settleRedeemEmergencyInKind(first)
    const epochBefore = await ctx.vault.tradingEpoch()

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(700n), ctx.lp1.address, ctx.lp1.address)
    const second = await closeRedeem(ctx)
    await time.increase(timeout)
    await expect(ctx.vault.connect(ctx.other).settleRedeemEmergencyInKind(second))
      .to.emit(ctx.vault, 'RedeemEpochSettled')
      .and.not.to.emit(ctx.vault, 'Paused')
    expect(await ctx.vault.tradingEpoch()).to.equal(epochBefore + 1n)
    await ctx.vault.connect(ctx.lp1).claim(second, ctx.lp1.address, ctx.lp1.address)
    expect(await ctx.vault.totalSupply()).to.equal(0)
  })
})
