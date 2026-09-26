/**
 * Hashlock M-02 — emergency in-kind exit read inventory mid-fill
 *
 * A preferred filler could call `settleRedeemEmergencyInKind` from its UniswapX
 * callback, after the reactor pulled the vault's input and before the output
 * arrived. The split then priced redeemers off a vault short the input, while
 * the late output accrued to the remaining holders.
 *
 * Remediation: an unpaused vault is only paused by the call. Inventory is read
 * by a later call, at a timestamp after the pause, when no fill can be in flight.
 */
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers, network } from 'hardhat'

import { encodeLimitOrder } from '../../helpers/limitOrderPermit2'
import { CANONICAL_PERMIT2, cngn, deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import { closeRedeem, seedShares } from '../helpers/vaultLifecycle'
import { signVaultEnvelope } from '../helpers/vaultSignatures'

async function emergencyReady() {
  const ctx = await deployOperatorVault({ realUniswapX: true })
  await seedShares(ctx, ctx.lp1, usdt(10_000n))
  await ctx.corridor.mint(await ctx.vault.getAddress(), cngn(1_000n))
  const half = (await ctx.vault.totalSupply()) / 2n
  await ctx.vault.connect(ctx.lp1).requestRedeem(half, ctx.lp1.address, ctx.lp1.address)
  const epochId = await closeRedeem(ctx)
  await time.increase(await ctx.vault.emergencyExitTimeout())
  return { ctx, epochId }
}

describe('Hashlock M-02 — emergency exit cannot split a vault mid-fill', function () {
  it('only pauses from inside a fill callback and settles on the completed inventory later', async function () {
    const { ctx, epochId } = await emergencyReady()
    const vaultAddr = await ctx.vault.getAddress()
    const Probe = await ethers.getContractFactory('EmergencyFillReentryProbe')
    const probe = await Probe.deploy(ctx.reactor, vaultAddr)
    const probeAddr = await probe.getAddress()
    await ctx.settlement.mint(probeAddr, usdt(1_000n))

    const block = await ethers.provider.getBlock('latest')
    const { signature, params } = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      reactor: ctx.reactor,
      vault: vaultAddr,
      permit2: CANONICAL_PERMIT2,
      chainId: 31337,
      nonce: ((await ctx.vault.tradingEpoch()) << 128n) | 1n,
      deadline: BigInt(block!.timestamp + 600),
      inputToken: ctx.corridor.target as string,
      inputAmount: cngn(1_000n),
      outputToken: ctx.settlement.target as string,
      outputAmount: usdt(1_000n),
      preferredFiller: ctx.preferredFiller,
      taker: probeAddr,
    })

    await expect(probe.fill({ order: encodeLimitOrder(params), sig: signature }, epochId))
      .to.emit(ctx.vault, 'Paused')
      .withArgs(probeAddr)
      .and.not.to.emit(ctx.vault, 'RedeemEpochSettled')
    expect(await probe.vaultInputSeen()).to.equal(0n)
    expect(await ctx.corridor.balanceOf(vaultAddr)).to.equal(0n)
    expect(await ctx.settlement.balanceOf(vaultAddr)).to.equal(usdt(11_000n))

    await expect(ctx.vault.connect(ctx.other).settleRedeemEmergencyInKind(epochId)).to.emit(
      ctx.vault,
      'RedeemEpochSettled'
    )
    const settlementBefore = await ctx.settlement.balanceOf(ctx.lp1.address)
    const corridorBefore = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - settlementBefore).to.equal(usdt(5_500n))
    expect(await ctx.corridor.balanceOf(ctx.lp1.address)).to.equal(corridorBefore)
  })

  it('does not settle in the block that paused the vault', async function () {
    const { ctx, epochId } = await emergencyReady()
    await network.provider.send('evm_setAutomine', [false])
    try {
      const pause = await ctx.vault.connect(ctx.guardian).pause()
      const settle = await ctx.vault.connect(ctx.other).settleRedeemEmergencyInKind(epochId, { gasLimit: 5_000_000 })
      await network.provider.send('evm_mine')
      await expect(pause).to.emit(ctx.vault, 'Paused')
      await expect(settle).to.not.emit(ctx.vault, 'RedeemEpochSettled')
    } finally {
      await network.provider.send('evm_setAutomine', [true])
    }
    await expect(ctx.vault.connect(ctx.other).settleRedeemEmergencyInKind(epochId)).to.emit(
      ctx.vault,
      'RedeemEpochSettled'
    )
  })
})
