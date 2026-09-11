/**
 * Audit regression — H-02 (external report, 2026-09-10, finding 1)
 *
 * A deposit epoch converting at `totalSupply() == 0` used the signed NAV. A
 * bare transfer landing between close and process, attested honestly, then
 * shrank the epoch to one share: every claim floored to zero and the share
 * sat under `minRedeemShares` forever. See `processDepositEpoch`.
 */
import { expect } from 'chai'

import { deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import type { DeployedVault } from '../fixtures/operatorVault.fixture'
import {
  closeDeposit,
  processDeposit,
  seedShares,
} from '../helpers/vaultLifecycle'

describe('AUDIT H-02 — bootstrap epoch survives a post-close donation', function () {
  const LP_DEPOSIT = usdt(1_000_000n)
  const ATTACKER_DEPOSIT = usdt(100n)
  const DONATION = usdt(500_050n) // half of the closed epoch total

  /** Close the open epoch, land a bare transfer, process with an honest
   *  signer attesting the live balance. Returns the NAV it signed. */
  async function closeDonateProcess(ctx: DeployedVault) {
    const epochId = await closeDeposit(ctx)
    await ctx.settlement.mint(await ctx.vault.getAddress(), DONATION)
    const navSigned = await processDeposit(ctx, epochId)
    return { epochId, navSigned }
  }

  it('converts the first epoch at its own value, so the donation dilutes nobody', async function () {
    const ctx = await deployOperatorVault()
    const { vault, lp1, lp2 } = ctx
    await vault
      .connect(lp1)
      .requestDeposit(LP_DEPOSIT, lp1.address, lp1.address)
    await vault
      .connect(lp2)
      .requestDeposit(ATTACKER_DEPOSIT, lp2.address, lp2.address)
    const { epochId, navSigned } = await closeDonateProcess(ctx)
    expect(navSigned).to.equal(DONATION)

    const epochTotal = LP_DEPOSIT + ATTACKER_DEPOSIT
    expect((await vault.epochs(epochId)).shares).to.equal(epochTotal)

    await vault.connect(lp1).claim(epochId, lp1.address, lp1.address)
    await vault.connect(lp2).claim(epochId, lp2.address, lp2.address)
    expect(await vault.balanceOf(lp1.address)).to.equal(LP_DEPOSIT)
    expect(await vault.balanceOf(lp2.address)).to.equal(ATTACKER_DEPOSIT)
    expect(await vault.totalSupply()).to.equal(epochTotal)

    // The donation is now plain NAV, shared by the same shares.
    expect(await vault.lastSettledNav()).to.equal(epochTotal + DONATION)

    // And the shares clear the redemption floor — nothing is stuck.
    await vault.connect(lp1).requestRedeem(LP_DEPOSIT, lp1.address, lp1.address)
  })

  it('cannot zero a minimum-size depositor once shares exist either', async function () {
    const ctx = await deployOperatorVault()
    const { vault, lp1, lp2 } = ctx
    await seedShares(ctx, lp2, ATTACKER_DEPOSIT)

    await vault
      .connect(lp1)
      .requestDeposit(LP_DEPOSIT, lp1.address, lp1.address)
    await vault
      .connect(lp2)
      .requestDeposit(ATTACKER_DEPOSIT, lp2.address, lp2.address)
    const { epochId } = await closeDonateProcess(ctx)

    await vault.connect(lp1).claim(epochId, lp1.address, lp1.address)
    await vault.connect(lp2).claim(epochId, lp2.address, lp2.address)
    const lp1Shares = await vault.balanceOf(lp1.address)
    const lp2Shares = await vault.balanceOf(lp2.address)
    expect(lp2Shares).to.be.gt(
      ATTACKER_DEPOSIT,
      'min-size depositor keeps a claim'
    )

    // Rounding costs each depositor less than one share, and a donation only
    // moves the share price by burning ~supply units of value per unit.
    const nav = await vault.lastSettledNav()
    const supply = await vault.totalSupply()
    const oneShare = nav / supply + 1n
    expect(oneShare).to.be.lt(usdt(1n) / 100n)
    expect((lp1Shares * nav) / supply + oneShare).to.be.gte(LP_DEPOSIT)
    expect((lp2Shares * nav) / supply + oneShare).to.be.gte(
      2n * ATTACKER_DEPOSIT
    )
  })
})
