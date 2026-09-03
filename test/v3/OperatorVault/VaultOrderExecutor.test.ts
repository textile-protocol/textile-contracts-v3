import { expect } from 'chai'
import { ethers } from 'hardhat'

import { encodeLimitOrder } from '../helpers/limitOrderPermit2'
import {
  CANONICAL_PERMIT2,
  deployOperatorVault,
  usdt,
  cngn,
  type DeployedVault,
} from './fixtures/operatorVault.fixture'
import { seedShares } from './helpers/vaultLifecycle'
import { signVaultEnvelope } from './helpers/vaultSignatures'
import type { VaultOrderExecutor } from '../../../typechain-types'

interface ExecutorContext extends DeployedVault {
  executor: VaultOrderExecutor
}

let nonceCounter = 1n

describe('VaultOrderExecutor', function () {
  async function deployExecutorContext(): Promise<ExecutorContext> {
    const ctx = await deployOperatorVault({
      realUniswapX: true,
      enableYield: true,
      minLiquidSettlement: usdt(1_000n),
    })
    const Executor = await ethers.getContractFactory('VaultOrderExecutor')
    const executor = await Executor.deploy(ctx.reactor, await ctx.factory.getAddress())
    await seedShares(ctx, ctx.lp1, usdt(10_000n))
    await ctx.vault.allocateIdle() // 9k staked, 1k liquid
    return { ...ctx, executor }
  }

  async function signedOrder(
    ctx: ExecutorContext,
    o: {
      inputToken: string
      inputAmount: bigint
      outputToken: string
      outputAmount: bigint
      taker: string
      /** Defaults to the real RFQ binding, {taker, executor}: fill() only
       *  lets a bound filler call it, and the reactor sees the executor. */
      fillers?: string[]
    }
  ) {
    const [block, epoch, executorAddr] = await Promise.all([
      ethers.provider.getBlock('latest'),
      ctx.vault.tradingEpoch(),
      ctx.executor.getAddress(),
    ])
    const { signature, params } = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      reactor: ctx.reactor,
      vault: ctx.vault.target as string,
      permit2: CANONICAL_PERMIT2,
      chainId: 31337,
      nonce: (epoch << 128n) | nonceCounter++,
      deadline: BigInt(block!.timestamp + 600),
      preferredFiller: ctx.preferredFiller,
      fillers: [o.taker, executorAddr],
      ...o,
    })
    return { order: encodeLimitOrder(params), sig: signature }
  }

  it('rejects zero constructor addresses', async function () {
    const ctx = await deployOperatorVault({ realUniswapX: true })
    const Executor = await ethers.getContractFactory('VaultOrderExecutor')
    const factoryAddr = await ctx.factory.getAddress()
    await expect(Executor.deploy(ethers.ZeroAddress, factoryAddr)).to.be.revertedWithCustomError(
      Executor,
      'ZeroAddress'
    )
    await expect(Executor.deploy(ctx.reactor, ethers.ZeroAddress)).to.be.revertedWithCustomError(
      Executor,
      'ZeroAddress'
    )
  })

  it('fills a settlement order from economic inventory and forwards both legs', async function () {
    const ctx = await deployExecutorContext()
    const executorAddr = await ctx.executor.getAddress()
    const vaultAddr = await ctx.vault.getAddress()
    const filler = ctx.other

    const order = await signedOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(5_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(5_000n),
      taker: filler.address,
    })

    await ctx.corridor.mint(filler.address, cngn(5_000n))
    await ctx.corridor.connect(filler).approve(executorAddr, ethers.MaxUint256)

    await expect(ctx.executor.connect(filler).fill(order))
      .to.emit(ctx.executor, 'ExecutorFill')
      .withArgs(
        vaultAddr,
        filler.address,
        ctx.settlement.target,
        usdt(5_000n),
        ctx.corridor.target,
        cngn(5_000n)
      )

    // Filler paid 5,000 cNGN and received the 5,000 USDT input.
    expect(await ctx.settlement.balanceOf(filler.address)).to.equal(usdt(5_000n))
    expect(await ctx.corridor.balanceOf(filler.address)).to.equal(0n)
    expect(await ctx.corridor.balanceOf(vaultAddr)).to.equal(cngn(5_000n))

    // 4k was recalled to cover the pull; nothing idle to restake afterwards.
    expect(await ctx.adapter.held()).to.equal(usdt(5_000n))
    expect(await ctx.settlement.balanceOf(vaultAddr)).to.equal(0n)

    // The executor never keeps anything.
    expect(await ctx.settlement.balanceOf(executorAddr)).to.equal(0n)
    expect(await ctx.corridor.balanceOf(executorAddr)).to.equal(0n)
  })

  it('needs prepareSettlement for a direct Permit2 fill, which stays permissionless', async function () {
    const ctx = await deployExecutorContext()
    const filler = ctx.other
    const reactor = await ethers.getContractAt('LimitOrderReactor', ctx.reactor)

    const order = await signedOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(5_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(5_000n),
      taker: filler.address,
      fillers: [filler.address],
    })
    await ctx.corridor.mint(filler.address, cngn(5_000n))
    await ctx.corridor.connect(filler).approve(ctx.reactor, ethers.MaxUint256)

    // Only 1k is liquid: ERC-1271 rejects the envelope until an unstake.
    await expect(reactor.connect(filler).execute(order)).to.be.reverted

    // Anyone can prepare; the existing settler EOA path then works unchanged.
    await ctx.vault.connect(ctx.lp2).prepareSettlement(usdt(5_000n))
    await reactor.connect(filler).execute(order)
    expect(await ctx.settlement.balanceOf(filler.address)).to.equal(usdt(5_000n))
    expect(await ctx.corridor.balanceOf(await ctx.vault.getAddress())).to.equal(cngn(5_000n))
  })

  it('funds the reactor output fee when a fee controller is set', async function () {
    const ctx = await deployExecutorContext()
    const executorAddr = await ctx.executor.getAddress()
    const filler = ctx.other
    const reactor = await ethers.getContractAt('LimitOrderReactor', ctx.reactor)

    const Controller = await ethers.getContractFactory('SellFirstFeeController')
    const controller = await Controller.deploy(ctx.feeRecipient.address, 3)
    await reactor.connect(ctx.deployer).setProtocolFeeController(await controller.getAddress())

    const output = cngn(5_000n)
    const fee = (output * 3n) / 10_000n
    const order = await signedOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(5_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: output,
      taker: filler.address,
    })

    // The caller funds the order output plus the injected 3 bps fee.
    await ctx.corridor.mint(filler.address, output + fee)
    await ctx.corridor.connect(filler).approve(executorAddr, ethers.MaxUint256)

    await ctx.executor.connect(filler).fill(order)

    expect(await ctx.corridor.balanceOf(await ctx.vault.getAddress())).to.equal(output)
    expect(await ctx.corridor.balanceOf(ctx.feeRecipient.address)).to.equal(fee)
    expect(await ctx.corridor.balanceOf(filler.address)).to.equal(0n)
    expect(await ctx.settlement.balanceOf(filler.address)).to.equal(usdt(5_000n))
    expect(await ctx.corridor.balanceOf(executorAddr)).to.equal(0n)
    expect(await ctx.settlement.balanceOf(executorAddr)).to.equal(0n)
  })

  it('never lets a direct fill spend pending deposits', async function () {
    const ctx = await deployExecutorContext() // liquid 1k, held 9k
    const filler = ctx.other
    const vaultAddr = await ctx.vault.getAddress()
    const reactor = await ethers.getContractAt('LimitOrderReactor', ctx.reactor)

    // Pending deposits push raw balanceOf (6k) above the order input (4k).
    await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(5_000n), ctx.lp2.address, ctx.lp2.address)
    const depositId = await ctx.vault.currentDepositEpochId()

    const order = await signedOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(4_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(4_000n),
      taker: filler.address,
      fillers: [filler.address],
    })
    await ctx.corridor.mint(filler.address, cngn(4_000n))
    await ctx.corridor.connect(filler).approve(ctx.reactor, ethers.MaxUint256)

    // Without a prepare, ERC-1271 caps at liquid (1k) and the fill reverts —
    // it must not succeed by eating the pending balance.
    await expect(reactor.connect(filler).execute(order)).to.be.reverted
    expect(await ctx.settlement.balanceOf(vaultAddr)).to.equal(usdt(6_000n))

    // After a prepare the same order fills without touching pending.
    await ctx.vault.prepareSettlement(usdt(4_000n))
    await reactor.connect(filler).execute(order)
    expect(await ctx.vault.pendingSettlement()).to.equal(usdt(5_000n))
    expect(await ctx.settlement.balanceOf(vaultAddr)).to.equal(usdt(5_000n))

    // The pending deposit is still fully backed and cancellable.
    await ctx.vault.connect(ctx.lp2).cancelDeposit(depositId, ctx.lp2.address)
    expect(await ctx.vault.pendingSettlement()).to.equal(0n)
  })

  it('restakes idle settlement after a corridor-to-settlement fill', async function () {
    const ctx = await deployExecutorContext()
    const executorAddr = await ctx.executor.getAddress()
    const filler = ctx.other
    await ctx.corridor.mint(await ctx.vault.getAddress(), cngn(5_000n))

    const order = await signedOrder(ctx, {
      inputToken: ctx.corridor.target as string,
      inputAmount: cngn(2_000n),
      outputToken: ctx.settlement.target as string,
      outputAmount: usdt(3_000n),
      taker: filler.address,
    })
    await ctx.settlement.mint(filler.address, usdt(3_000n))
    await ctx.settlement.connect(filler).approve(executorAddr, ethers.MaxUint256)

    await expect(ctx.executor.connect(filler).fill(order))
      .to.emit(ctx.vault, 'IdleAllocated')
      .withArgs(usdt(3_000n))

    expect(await ctx.adapter.held()).to.equal(usdt(12_000n))
    expect(await ctx.settlement.balanceOf(await ctx.vault.getAddress())).to.equal(usdt(1_000n))
    expect(await ctx.corridor.balanceOf(filler.address)).to.equal(cngn(2_000n))
    expect(await ctx.settlement.balanceOf(executorAddr)).to.equal(0n)
    expect(await ctx.corridor.balanceOf(executorAddr)).to.equal(0n)
  })

  it('still fills when post-fill restaking hits an Aave supply failure', async function () {
    const ctx = await deployExecutorContext() // liquid 1k, held 9k
    const executorAddr = await ctx.executor.getAddress()
    const filler = ctx.other
    await ctx.corridor.mint(await ctx.vault.getAddress(), cngn(5_000n))

    const order = await signedOrder(ctx, {
      inputToken: ctx.corridor.target as string,
      inputAmount: cngn(2_000n),
      outputToken: ctx.settlement.target as string,
      outputAmount: usdt(3_000n),
      taker: filler.address,
    })
    await ctx.settlement.mint(filler.address, usdt(3_000n))
    await ctx.settlement.connect(filler).approve(executorAddr, ethers.MaxUint256)

    // Aave rejects supply: the fill must complete, the idle stays liquid.
    await ctx.aavePool.setSupplyReverts(true)
    await expect(ctx.executor.connect(filler).fill(order)).to.emit(ctx.executor, 'ExecutorFill')

    expect(await ctx.adapter.held()).to.equal(usdt(9_000n))
    expect(await ctx.settlement.balanceOf(await ctx.vault.getAddress())).to.equal(usdt(4_000n))
    expect(await ctx.corridor.balanceOf(filler.address)).to.equal(cngn(2_000n))
    expect(await ctx.settlement.balanceOf(executorAddr)).to.equal(0n)
    expect(await ctx.corridor.balanceOf(executorAddr)).to.equal(0n)

    // Once Aave recovers, a plain allocateIdle restakes the idle balance.
    await ctx.aavePool.setSupplyReverts(false)
    await ctx.vault.allocateIdle()
    expect(await ctx.adapter.held()).to.equal(usdt(12_000n))
  })

  it('rejects orders whose swapper is not a factory vault', async function () {
    const ctx = await deployExecutorContext()
    const { params } = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      reactor: ctx.reactor,
      vault: ctx.other.address,
      permit2: CANONICAL_PERMIT2,
      chainId: 31337,
      nonce: 1n << 128n,
      deadline: BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 600),
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(100n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(100n),
      preferredFiller: ctx.preferredFiller,
      taker: await ctx.executor.getAddress(),
    })
    await expect(
      ctx.executor.fill({ order: encodeLimitOrder(params), sig: '0x' })
    ).to.be.revertedWithCustomError(ctx.executor, 'UnknownVault')
  })

  it('rejects orders targeting a different reactor', async function () {
    const ctx = await deployExecutorContext()
    const { params } = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      reactor: ethers.Wallet.createRandom().address,
      vault: ctx.vault.target as string,
      permit2: CANONICAL_PERMIT2,
      chainId: 31337,
      nonce: 1n << 128n,
      deadline: BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 600),
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(100n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(100n),
      preferredFiller: ctx.preferredFiller,
      taker: await ctx.executor.getAddress(),
    })
    await expect(
      ctx.executor.fill({ order: encodeLimitOrder(params), sig: '0x' })
    ).to.be.revertedWithCustomError(ctx.executor, 'UnsupportedOrder')
  })

  it('rejects a caller who is not a bound preferred filler', async function () {
    const ctx = await deployExecutorContext()
    const executorAddr = await ctx.executor.getAddress()
    const taker = ctx.lp2
    const frontRunner = ctx.other

    // Bound to {taker, executor}; exclusive for its whole life (exclusiveUntil = deadline).
    const order = await signedOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(5_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(5_000n),
      taker: taker.address,
    })

    // A searcher who copied the mempool blob funds the output and calls fill —
    // the reactor would accept the executor as filler, the wrapper rejects them.
    await ctx.corridor.mint(frontRunner.address, cngn(5_000n))
    await ctx.corridor.connect(frontRunner).approve(executorAddr, ethers.MaxUint256)
    await expect(ctx.executor.connect(frontRunner).fill(order)).to.be.revertedWithCustomError(
      ctx.executor,
      'CallerNotPreferredFiller'
    )

    // The bound taker fills the same order and receives the input.
    await ctx.corridor.mint(taker.address, cngn(5_000n))
    await ctx.corridor.connect(taker).approve(executorAddr, ethers.MaxUint256)
    const before = await ctx.settlement.balanceOf(taker.address)
    await ctx.executor.connect(taker).fill(order)
    expect((await ctx.settlement.balanceOf(taker.address)) - before).to.equal(usdt(5_000n))
  })
})
