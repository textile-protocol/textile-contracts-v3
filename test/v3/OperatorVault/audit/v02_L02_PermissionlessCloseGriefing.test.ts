import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  DAY,
  deployOperatorVault,
  PRICE_1,
  usdt,
} from '../fixtures/operatorVault.fixture'
import { seedShares } from '../helpers/vaultLifecycle'
import { attestationSignatures, freshAttestation } from '../helpers/vaultSignatures'

async function settle(ctx: DeployedVault, epochId: bigint) {
  const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
  const sigs = await attestationSignatures(ctx, att)
  await ctx.vault.settleRedeemEpoch(epochId, att, ...sigs)
}

// v0.2 L-02: closeRedeemEpoch used to be open to anyone the moment the
// duration and cooldown elapsed. Closing bumps the trading epoch (every quote
// dies) and holds the vault close-only until settlement, so one minimum-size
// holder could force both on the operator every cycle. The trigger is now the
// operator's: admin and strategy signer close whenever they like, and a third
// party is a backstop that also has to wait out `valuationTimeout`.
describe('audit v0.2 L-02 — the redeem close belongs to the operator', function () {
  it("the audit's proof no longer runs: three cycles from one 300-USDT position", async function () {
    // v0.2's proof: request a minimum redeem, wait max(duration, cooldown),
    // close, repeat — three epoch bumps and close-only windows on the
    // griefer's schedule. Now every close on that cadence reverts, and the
    // only close the griefer can force lands a full `valuationTimeout`
    // later, with the operator free to pre-empt it.
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    await seedShares(ctx, ctx.lp2, usdt(300n))
    const [duration, cooldown] = await Promise.all([
      ctx.vault.redemptionEpochDuration(),
      ctx.vault.redemptionCloseCooldown(),
    ])
    const cycle = duration > cooldown ? duration : cooldown
    const quoteEpoch = await ctx.vault.tradingEpoch()

    for (let i = 0; i < 3; i++) {
      await ctx.vault
        .connect(ctx.lp2)
        .requestRedeem(usdt(100n), ctx.lp2.address, ctx.lp2.address)
      const epochId = await ctx.vault.currentRedeemEpochId()
      await time.increase(cycle)
      await expect(
        ctx.vault.connect(ctx.lp2).closeRedeemEpoch(epochId)
      ).to.be.revertedWithCustomError(ctx.vault, 'EpochNotReady')
      // The operator settles the queue on its own terms instead.
      await ctx.vault.connect(ctx.strategy).closeRedeemEpoch(epochId)
      await settle(ctx, epochId)
    }
    // Three bumps happened — the operator's, when it chose. The griefer's
    // own transactions moved nothing.
    expect(await ctx.vault.tradingEpoch()).to.equal(quoteEpoch + 3n)
    expect(await ctx.vault.closeOnly()).to.equal(false)
  })

  it('the strategy signer and the admin close on their own schedule, cooldown or not', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)

    // Straight away, well inside the duration.
    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const first = await ctx.vault.currentRedeemEpochId()
    await expect(
      ctx.vault.connect(ctx.strategy).closeRedeemEpoch(first)
    ).to.emit(ctx.vault, 'EpochClosed')
    await settle(ctx, first)

    // And again inside the cooldown, from the admin key this time.
    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const second = await ctx.vault.currentRedeemEpochId()
    await expect(
      ctx.vault.connect(ctx.other).closeRedeemEpoch(second)
    ).to.be.revertedWithCustomError(ctx.vault, 'EpochNotReady')
    await expect(
      ctx.vault.connect(ctx.operatorAdmin).closeRedeemEpoch(second)
    ).to.emit(ctx.vault, 'EpochClosed')
  })

  it('anyone is still the backstop once duration + valuationTimeout and the cooldown have passed', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const first = await ctx.vault.currentRedeemEpochId()
    await ctx.vault.connect(ctx.strategy).closeRedeemEpoch(first)
    await settle(ctx, first)

    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const second = await ctx.vault.currentRedeemEpochId()
    const grace =
      (await ctx.vault.redemptionEpochDuration()) +
      (await ctx.vault.valuationTimeout())
    await time.increase(grace - 10n)
    await expect(
      ctx.vault.connect(ctx.other).closeRedeemEpoch(second)
    ).to.be.revertedWithCustomError(ctx.vault, 'EpochNotReady')
    await time.increase(10n)
    // The cooldown (a day) sits inside the grace (two days) here, so this is
    // the public window opening.
    const epochBefore = await ctx.vault.tradingEpoch()
    await expect(ctx.vault.connect(ctx.other).closeRedeemEpoch(second)).to.emit(
      ctx.vault,
      'EpochClosed'
    )
    expect(await ctx.vault.tradingEpoch()).to.equal(epochBefore + 1n)
    expect(await ctx.vault.closeOnly()).to.equal(true)
  })

  it('a third party still respects the cooldown after the grace', async function () {
    const ctx = await deployOperatorVault({ redemptionCloseCooldown: 5 * DAY })
    await seedShares(ctx, ctx.lp1)
    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const first = await ctx.vault.currentRedeemEpochId()
    await ctx.vault.connect(ctx.strategy).closeRedeemEpoch(first)
    await settle(ctx, first)

    await ctx.vault
      .connect(ctx.lp1)
      .requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const second = await ctx.vault.currentRedeemEpochId()
    await time.increase(2 * DAY)
    await expect(
      ctx.vault.connect(ctx.other).closeRedeemEpoch(second)
    ).to.be.revertedWithCustomError(ctx.vault, 'CloseCooldownActive')
    await time.increase(3 * DAY)
    await expect(ctx.vault.connect(ctx.other).closeRedeemEpoch(second)).to.emit(
      ctx.vault,
      'EpochClosed'
    )
  })
})
