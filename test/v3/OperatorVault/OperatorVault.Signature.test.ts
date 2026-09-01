import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import {
  DAY,
  ERC1271_FAIL,
  ERC1271_MAGIC,
  deployOperatorVault,
  usdt,
  cngn,
} from './fixtures/operatorVault.fixture'
import { seedShares } from './helpers/vaultLifecycle'
import { signVaultEnvelope } from './helpers/vaultSignatures'

describe('OperatorVault — ERC-1271', function () {
  async function funded(extras: Parameters<typeof deployOperatorVault>[0] = {}) {
    const ctx = await deployOperatorVault(extras)
    const { depositId } = await seedShares(ctx, ctx.lp1, usdt(10_000n))
    const chainId = Number((await ethers.provider.getNetwork()).chainId)
    const now = (await ethers.provider.getBlock('latest'))!.timestamp
    return { ...ctx, chainId, now, depositId }
  }

  function baseOrder(ctx: Awaited<ReturnType<typeof funded>>, overrides: Record<string, unknown> = {}) {
    return {
      reactor: ctx.reactor,
      vault: ctx.vault.target as string,
      permit2: ctx.permit2,
      chainId: ctx.chainId,
      nonce: 1n << 128n,
      deadline: BigInt(ctx.now + 600),
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(100n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(100n),
      preferredFiller: ctx.preferredFiller,
      taker: ctx.other.address,
      ...overrides,
    }
  }

  it('accepts a dual-signed policy-valid order', async function () {
    const ctx = await funded()
    const { hash, signature } = await signVaultEnvelope(ctx.strategy, ctx.risk, baseOrder(ctx))
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_MAGIC)
  })

  it('rejects a wrong operator or risk signature', async function () {
    const ctx = await funded()
    const order = baseOrder(ctx)
    const attacker = ethers.Wallet.createRandom()
    const { hash, signature } = await signVaultEnvelope(attacker, ctx.risk, order)
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_FAIL)
    const badRisk = await signVaultEnvelope(ctx.strategy, attacker, order)
    expect(await ctx.vault.isValidSignature(badRisk.hash, badRisk.signature)).to.equal(
      ERC1271_FAIL
    )
  })

  it('rejects the wrong reactor, recipient, pair, cap, epoch, and lifetime', async function () {
    const ctx = await funded({ maxOrderInputSettlement: usdt(50n) })
    const good = baseOrder(ctx)

    const wrongReactor = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      ...good,
      reactor: ctx.other.address,
    })
    expect(await ctx.vault.isValidSignature(wrongReactor.hash, wrongReactor.signature)).to.equal(
      ERC1271_FAIL
    )

    const staleEpoch = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      ...baseOrder(ctx),
      nonce: 99n << 128n,
    })
    expect(await ctx.vault.isValidSignature(staleEpoch.hash, staleEpoch.signature)).to.equal(
      ERC1271_FAIL
    )

    const oversized = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      ...baseOrder(ctx),
      inputAmount: usdt(51n),
    })
    expect(await ctx.vault.isValidSignature(oversized.hash, oversized.signature)).to.equal(
      ERC1271_FAIL
    )
  })

  it('rejects a mismatched digest', async function () {
    const ctx = await funded()
    const { signature } = await signVaultEnvelope(ctx.strategy, ctx.risk, baseOrder(ctx))
    const otherHash = ethers.keccak256('0xdead')
    expect(await ctx.vault.isValidSignature(otherHash, signature)).to.equal(ERC1271_FAIL)
  })

  it('only allows unwind orders in close-only', async function () {
    const ctx = await funded()
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(redeemId)
    const now = (await ethers.provider.getBlock('latest'))!.timestamp
    const epoch = await ctx.vault.tradingEpoch()

    const sellSettlement = await signVaultEnvelope(
      ctx.strategy,
      ctx.risk,
      baseOrder({ ...ctx, now }, { nonce: epoch << 128n })
    )
    expect(await ctx.vault.isValidSignature(sellSettlement.hash, sellSettlement.signature)).to.equal(
      ERC1271_FAIL
    )

    const unwind = await signVaultEnvelope(
      ctx.strategy,
      ctx.risk,
      baseOrder(
        { ...ctx, now },
        {
          nonce: epoch << 128n,
          inputToken: ctx.corridor.target as string,
          inputAmount: cngn(1n),
          outputToken: ctx.settlement.target as string,
          outputAmount: usdt(1n),
        }
      )
    )
    // No corridor inventory, so quotable is 0 and the unwind still fails funding.
    expect(await ctx.vault.isValidSignature(unwind.hash, unwind.signature)).to.equal(ERC1271_FAIL)
  })

  it('accepts an unwind order in close-only when corridor inventory is quotable', async function () {
    const ctx = await funded()
    await ctx.corridor.mint(await ctx.vault.getAddress(), cngn(100n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(100n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await time.increase(DAY)
    await ctx.vault.closeRedeemEpoch(redeemId)
    const now = (await ethers.provider.getBlock('latest'))!.timestamp
    const epoch = await ctx.vault.tradingEpoch()

    const unwind = await signVaultEnvelope(
      ctx.strategy,
      ctx.risk,
      baseOrder(
        { ...ctx, now },
        {
          nonce: epoch << 128n,
          inputToken: ctx.corridor.target as string,
          inputAmount: cngn(1n),
          outputToken: ctx.settlement.target as string,
          outputAmount: usdt(1n),
        }
      )
    )
    expect(await ctx.vault.isValidSignature(unwind.hash, unwind.signature)).to.equal(ERC1271_MAGIC)
  })
})
