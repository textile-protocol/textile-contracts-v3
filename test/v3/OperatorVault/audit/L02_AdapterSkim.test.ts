/**
 * Audit regression — L-02 (Resolved)
 *
 * The adapter deliberately has no admin surface, which meant any token
 * force-sent to it was stuck forever. `skim(token)` now recovers a stray
 * balance by pushing it to the vault — permissionless because the destination
 * is fixed: underlying is socialised to shareholders, junk becomes
 * guardian-sweepable, and neither the aToken position nor the implementation
 * contract (which locks `vault` to itself) can be skimmed.
 */
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import { seedShares } from '../helpers/vaultLifecycle'

describe('AUDIT L-02 — adapter can recover force-sent tokens', function () {
  it('skims stray underlying and junk to the vault, never the position', async function () {
    const ctx = await deployOperatorVault({ enableYield: true })
    await seedShares(ctx, ctx.lp1, usdt(1_000n))
    await ctx.vault.allocateIdle()
    const adapterAddr = await ctx.adapter.getAddress()
    const vaultAddr = await ctx.vault.getAddress()
    const settlementAddr = await ctx.settlement.getAddress()

    // Force-sent underlying is recoverable by anyone, straight to the vault.
    await ctx.settlement.mint(adapterAddr, usdt(50n))
    const vaultBefore = await ctx.settlement.balanceOf(vaultAddr)
    await expect(ctx.adapter.connect(ctx.other).skim(settlementAddr))
      .to.emit(ctx.adapter, 'Skimmed')
      .withArgs(settlementAddr, usdt(50n))
    expect((await ctx.settlement.balanceOf(vaultAddr)) - vaultBefore).to.equal(usdt(50n))
    expect(await ctx.settlement.balanceOf(adapterAddr)).to.equal(0n)

    // Junk tokens too.
    const Junk = await ethers.getContractFactory('ERC20Mock')
    const junk = await Junk.deploy('Junk', 'JNK', 18)
    const junkAddr = await junk.getAddress()
    await junk.mint(adapterAddr, 7n)
    await ctx.adapter.skim(junkAddr)
    expect(await junk.balanceOf(vaultAddr)).to.equal(7n)

    // The position is not skimmable, and empty skims revert.
    await expect(ctx.adapter.skim(await ctx.aToken.getAddress())).to.be.revertedWithCustomError(
      ctx.adapter,
      'InvalidPair'
    )
    await expect(ctx.adapter.skim(junkAddr)).to.be.revertedWithCustomError(ctx.adapter, 'ZeroAmount')
    expect(await ctx.adapter.held()).to.equal(usdt(1_000n))

    // The implementation locks `vault` to itself. A skim there would be a
    // self-transfer that emits a recovery it never made, so it reverts instead.
    await junk.mint(await ctx.adapterImpl.getAddress(), 1n)
    await expect(ctx.adapterImpl.skim(junkAddr)).to.be.revertedWithCustomError(
      ctx.adapter,
      'InvalidPair'
    )
  })
})
