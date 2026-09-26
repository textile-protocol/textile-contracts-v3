import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import { cngn, deployOperatorVault, PRICE_1, usdt, type DeployedVault } from '../fixtures/operatorVault.fixture'
import { closeAndSettleRedeem, closeDeposit, seedShares } from '../helpers/vaultLifecycle'
import { attestationSignatures, freshAttestation } from '../helpers/vaultSignatures'

// Hashlock M-03: a deposit epoch only had to mint one share. With one share
// outstanding worth 200 USDC, two 100 USDC deposits minted one share in total;
// the first claim floored to zero and the last claimant took it.
describe('audit Hashlock M-03 — an epoch mints a share per minimum deposit', function () {
  /** lp2 redeems down to one share, then tops the vault up to `nav`. */
  async function inflateToOneShare(ctx: DeployedVault, nav = usdt(200n)) {
    const { vault, lp2, settlement } = ctx
    await seedShares(ctx, lp2, usdt(1_000n))
    await vault.connect(lp2).requestRedeem(usdt(1_000n) - 1n, lp2.address, lp2.address)
    const redeemId = await closeAndSettleRedeem(ctx)
    await vault.connect(lp2).claim(redeemId, lp2.address, lp2.address)
    expect(await vault.totalSupply()).to.equal(1n)
    await settlement.mint(await vault.getAddress(), nav - (await vault.freeSettlement()))
  }

  for (const inCorridor of [false, true]) {
    const amount = inCorridor ? cngn(100n) : usdt(100n)
    const label = inCorridor ? 'corridor' : 'settlement'

    it(`refuses to settle a ${label} epoch that would floor a claim to zero, and refunds it`, async function () {
      const ctx = await deployOperatorVault()
      const { vault, lp1, lp2, settlement, corridor } = ctx
      await inflateToOneShare(ctx)

      const request = inCorridor ? 'requestDepositCorridor' : 'requestDeposit'
      await vault.connect(lp1)[request](amount, lp1.address, lp1.address)
      await vault.connect(lp2)[request](amount, lp2.address, lp2.address)
      const epochId = await closeDeposit(
        ctx,
        inCorridor ? await vault.currentCorridorDepositEpochId() : undefined
      )

      const att = await freshAttestation(vault, epochId, PRICE_1)
      const sigs = await attestationSignatures(ctx, att)
      await expect(vault.processDepositEpoch(epochId, att, ...sigs)).to.be.revertedWithCustomError(
        vault,
        'ZeroAmount'
      )

      await time.increase(await vault.valuationTimeout())
      await vault.voidDepositEpoch(epochId)
      const token = inCorridor ? corridor : settlement
      const before = await token.balanceOf(lp1.address)
      await vault.connect(lp1).claim(epochId, lp1.address, lp1.address)
      expect((await token.balanceOf(lp1.address)) - before).to.equal(amount)
    })
  }

  it('gives every minimum-size depositor a share once the epoch mints enough', async function () {
    const ctx = await deployOperatorVault()
    const { vault, lp1, lp2 } = ctx
    await inflateToOneShare(ctx, usdt(150n))

    // 300 USDC across two requests mints floor(300 * 2 / 150) = 3 shares, one per minimum.
    await vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
    await vault.connect(lp2).requestDeposit(usdt(200n), lp2.address, lp2.address)
    const epochId = await closeDeposit(ctx)
    const att = await freshAttestation(vault, epochId, PRICE_1)
    await vault.processDepositEpoch(epochId, att, ...(await attestationSignatures(ctx, att)))
    expect((await vault.epochs(epochId)).shares).to.equal(3n)

    await vault.connect(lp1).claim(epochId, lp1.address, lp1.address)
    expect(await vault.balanceOf(lp1.address)).to.equal(1n)
  })
})
