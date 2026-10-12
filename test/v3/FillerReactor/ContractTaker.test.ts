/**
 * A DEX aggregator's router contract as the RFQ taker.
 *
 * The router pulls the user's sell token, approves the fill target (reactor
 * for executeBatch, VaultOrderExecutor for a single vault order), fills, and
 * forwards the buy token to the user. The reactor only ever sees the router
 * (msg.sender), so the quote's `taker` — the address in the order's
 * preferred-filler list — has to be the router, not the end user.
 *
 * Naming from the taker's side: the taker sells the order's OUTPUT token
 * (cNGN here, plus the injected fee) and buys the order's INPUT token (USDT).
 */
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { expect } from 'chai'
import { AbiCoder, Wallet, type HDNodeWallet } from 'ethers'
import { ethers, network } from 'hardhat'
import { privateKeyToAccount } from 'viem/accounts'

import { CANONICAL_PERMIT2, etchPermit2 } from '../helpers/etchPermit2'
import {
  encodeLimitOrder,
  permit2Digest,
  type LimitOrderParams,
} from '../helpers/limitOrderPermit2'
import { cngn as cngnUnits, usdt as usdtUnits } from '../OperatorVault/fixtures/operatorVault.fixture'
import {
  deployExecutorContext,
  signedExecutorOrder,
} from '../OperatorVault/helpers/executor'

const FEE_BPS = 3n
const feeOf = (amount: bigint) => (amount * FEE_BPS) / 10_000n

let nonceSeed = BigInt(Date.now()) << 16n
const nextNonce = () => nonceSeed++

const latestTimestamp = async () =>
  BigInt((await ethers.provider.getBlock('latest'))!.timestamp)

async function deployEoaContext() {
  await etchPermit2()
  const [user, owner, feeRecipient] = await ethers.getSigners()
  const Token = await ethers.getContractFactory('BlockableERC20Mock')
  const usdt = await Token.deploy('USD Tether', 'USDT', 6)
  const cngn = await Token.deploy('cNGN', 'cNGN', 18)

  const reactor = await (
    await ethers.getContractFactory('LimitOrderReactor')
  ).deploy(CANONICAL_PERMIT2, owner.address)
  const controller = await (
    await ethers.getContractFactory('SellFirstFeeController')
  ).deploy(feeRecipient.address, FEE_BPS)
  await reactor.connect(owner).setProtocolFeeController(await controller.getAddress())
  const validation = await (
    await ethers.getContractFactory('PreferredFillerValidation')
  ).deploy()
  const router = await (
    await ethers.getContractFactory('AggregatorRouterMock')
  ).deploy()

  return { user, feeRecipient, usdt, cngn, reactor, validation, router }
}

type EoaContext = Awaited<ReturnType<typeof deployEoaContext>>

/** Fresh EOA maker with gas, holding `inputAmount` USDT approved to Permit2. */
async function fundedMaker(c: EoaContext, inputAmount: bigint) {
  const maker = Wallet.createRandom().connect(ethers.provider)
  await network.provider.send('hardhat_setBalance', [maker.address, '0xDE0B6B3A7640000'])
  await c.usdt.mint(maker.address, inputAmount)
  await c.usdt.connect(maker).approve(CANONICAL_PERMIT2, ethers.MaxUint256)
  return maker
}

/** A maker-signed limit order: maker sells USDT for cNGN, exclusive to `fillers`. */
async function signedMakerOrder(
  c: EoaContext,
  maker: HDNodeWallet,
  o: { inputAmount: bigint; outputAmount: bigint; fillers: string[] }
) {
  const deadline = (await latestTimestamp()) + 600n
  const params: LimitOrderParams = {
    reactor: (await c.reactor.getAddress()) as `0x${string}`,
    swapper: maker.address as `0x${string}`,
    nonce: nextNonce(),
    deadline,
    inputToken: (await c.usdt.getAddress()) as `0x${string}`,
    inputAmount: o.inputAmount,
    outputToken: (await c.cngn.getAddress()) as `0x${string}`,
    outputAmount: o.outputAmount,
    recipient: maker.address as `0x${string}`,
    additionalValidationContract: (await c.validation.getAddress()) as `0x${string}`,
    additionalValidationData: AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint256'],
      [o.fillers, deadline]
    ) as `0x${string}`,
  }
  const signer = privateKeyToAccount(maker.privateKey as `0x${string}`)
  const sig = await signer.sign({ hash: permit2Digest(params, CANONICAL_PERMIT2, 31337) })
  return { signed: { order: encodeLimitOrder(params), sig }, deadline }
}

/** User funds and approves the ROUTER (not the reactor) for the sell leg. */
async function fundUser(c: EoaContext, amount: bigint) {
  await c.cngn.mint(c.user.address, amount)
  await c.cngn.connect(c.user).approve(await c.router.getAddress(), amount)
}

describe('Contract taker (aggregator router)', () => {
  // The vault fixture fast-forwards chain time through deposit epochs. Revert
  // afterwards so sibling suites that sign wall-clock deadlines are unaffected.
  let snapshot: string
  before(async () => {
    snapshot = await network.provider.send('evm_snapshot', [])
  })
  after(async () => {
    await network.provider.send('evm_revert', [snapshot])
  })

  it('fills a single EOA-maker order via executeBatch with the router as taker', async () => {
    const c = await deployEoaContext()
    const routerA = await c.router.getAddress()
    const input = usdtUnits(100n)
    const output = cngnUnits(150n)
    const fee = feeOf(output)
    const takerPays = output + fee

    const maker = await fundedMaker(c, input)
    const { signed } = await signedMakerOrder(c, maker, {
      inputAmount: input,
      outputAmount: output,
      fillers: [routerA],
    })
    await fundUser(c, takerPays)

    await expect(
      c.router
        .connect(c.user)
        .swapViaReactor(
          await c.reactor.getAddress(),
          [signed],
          await c.cngn.getAddress(),
          takerPays,
          await c.usdt.getAddress(),
          input,
          c.user.address
        )
    )
      // The reactor records the router as the filler.
      .to.emit(c.reactor, 'Fill')
      .withArgs(anyValue, routerA, maker.address, anyValue)

    // User: paid output + fee in cNGN, received the maker's full USDT input.
    expect(await c.usdt.balanceOf(c.user.address)).to.equal(input)
    expect(await c.cngn.balanceOf(c.user.address)).to.equal(0n)
    // Maker: gave USDT, got exactly the signed output; fee sits on top, paid by the taker.
    expect(await c.usdt.balanceOf(maker.address)).to.equal(0n)
    expect(await c.cngn.balanceOf(maker.address)).to.equal(output)
    expect(await c.cngn.balanceOf(c.feeRecipient.address)).to.equal(fee)
    // Router: nothing left behind, approval revoked.
    expect(await c.usdt.balanceOf(routerA)).to.equal(0n)
    expect(await c.cngn.balanceOf(routerA)).to.equal(0n)
    expect(await c.cngn.allowance(routerA, await c.reactor.getAddress())).to.equal(0n)
  })

  it('fills a two-maker bundle via executeBatch with the router as taker', async () => {
    const c = await deployEoaContext()
    const routerA = await c.router.getAddress()
    const legs = [
      { inputAmount: usdtUnits(100n), outputAmount: cngnUnits(150n) },
      { inputAmount: usdtUnits(40n), outputAmount: cngnUnits(61n) },
    ]
    const makers = await Promise.all(legs.map((l) => fundedMaker(c, l.inputAmount)))
    const orders = []
    for (const [i, leg] of legs.entries()) {
      orders.push((await signedMakerOrder(c, makers[i], { ...leg, fillers: [routerA] })).signed)
    }
    // The fee controller runs per order, so the bundle's fee is the sum of per-order fees.
    const totalIn = legs.reduce((s, l) => s + l.inputAmount, 0n)
    const totalFee = legs.reduce((s, l) => s + feeOf(l.outputAmount), 0n)
    const takerPays = legs.reduce((s, l) => s + l.outputAmount, 0n) + totalFee
    await fundUser(c, takerPays)

    await c.router
      .connect(c.user)
      .swapViaReactor(
        await c.reactor.getAddress(),
        orders,
        await c.cngn.getAddress(),
        takerPays,
        await c.usdt.getAddress(),
        totalIn,
        c.user.address
      )

    expect(await c.usdt.balanceOf(c.user.address)).to.equal(totalIn)
    expect(await c.cngn.balanceOf(c.user.address)).to.equal(0n)
    for (const [i, leg] of legs.entries()) {
      expect(await c.usdt.balanceOf(makers[i].address)).to.equal(0n)
      expect(await c.cngn.balanceOf(makers[i].address)).to.equal(leg.outputAmount)
    }
    expect(await c.cngn.balanceOf(c.feeRecipient.address)).to.equal(totalFee)
    expect(await c.usdt.balanceOf(routerA)).to.equal(0n)
    expect(await c.cngn.balanceOf(routerA)).to.equal(0n)
  })

  it('fills an OperatorVault (ERC-1271) order via VaultOrderExecutor.fill with the router as taker', async () => {
    const ctx = await deployExecutorContext() // 1k liquid, 9k in the yield adapter
    const executorA = await ctx.executor.getAddress()
    const vaultA = await ctx.vault.getAddress()
    const reactor = await ethers.getContractAt('LimitOrderReactor', ctx.reactor)
    const controller = await (
      await ethers.getContractFactory('SellFirstFeeController')
    ).deploy(ctx.feeRecipient.address, FEE_BPS)
    await reactor.connect(ctx.deployer).setProtocolFeeController(await controller.getAddress())
    const router = await (await ethers.getContractFactory('AggregatorRouterMock')).deploy()
    const routerA = await router.getAddress()
    const user = ctx.lp2

    const input = usdtUnits(5_000n) // needs a prepareSettlement unstake, which the executor does
    const output = cngnUnits(5_000n)
    const fee = feeOf(output)
    const takerPays = output + fee
    // Real RFQ binding for executor fills: {taker, executor}, taker = router.
    const signed = await signedExecutorOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: input,
      outputToken: ctx.corridor.target as string,
      outputAmount: output,
      taker: routerA,
    })
    const userUsdtBefore = await ctx.settlement.balanceOf(user.address)
    const userCngnBefore = await ctx.corridor.balanceOf(user.address)
    await ctx.corridor.mint(user.address, takerPays)
    await ctx.corridor.connect(user).approve(routerA, takerPays)

    await expect(
      router
        .connect(user)
        .swapViaExecutor(
          executorA,
          signed,
          ctx.corridor.target as string,
          takerPays,
          ctx.settlement.target as string,
          input,
          user.address
        )
    )
      .to.emit(ctx.executor, 'ExecutorFill')
      .withArgs(vaultA, routerA, ctx.settlement.target, input, ctx.corridor.target, output)

    expect((await ctx.settlement.balanceOf(user.address)) - userUsdtBefore).to.equal(input)
    expect(await ctx.corridor.balanceOf(user.address)).to.equal(userCngnBefore)
    expect(await ctx.corridor.balanceOf(vaultA)).to.equal(output)
    expect(await ctx.corridor.balanceOf(ctx.feeRecipient.address)).to.equal(fee)
    for (const holder of [routerA, executorA]) {
      expect(await ctx.settlement.balanceOf(holder)).to.equal(0n)
      expect(await ctx.corridor.balanceOf(holder)).to.equal(0n)
    }
  })

  it('reverts when the router fills an order bound to the end user instead of the router', async () => {
    const c = await deployEoaContext()
    const input = usdtUnits(100n)
    const output = cngnUnits(150n)
    const takerPays = output + feeOf(output)

    const maker = await fundedMaker(c, input)
    // Quote requested with taker = end user: the reactor sees the router as filler.
    const { signed, deadline } = await signedMakerOrder(c, maker, {
      inputAmount: input,
      outputAmount: output,
      fillers: [c.user.address],
    })
    await fundUser(c, takerPays)

    await expect(
      c.router
        .connect(c.user)
        .swapViaReactor(
          await c.reactor.getAddress(),
          [signed],
          await c.cngn.getAddress(),
          takerPays,
          await c.usdt.getAddress(),
          input,
          c.user.address
        )
    )
      .to.be.revertedWithCustomError(c.validation, 'FillerNotPreferred')
      .withArgs(await c.router.getAddress(), deadline)
  })

  it('reverts on the executor path when the vault order binds {user, executor}', async () => {
    const ctx = await deployExecutorContext()
    const router = await (await ethers.getContractFactory('AggregatorRouterMock')).deploy()
    const routerA = await router.getAddress()
    const user = ctx.lp2
    const output = cngnUnits(5_000n)

    const signed = await signedExecutorOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: usdtUnits(5_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: output,
      taker: user.address,
    })
    await ctx.corridor.connect(user).approve(routerA, output)

    await expect(
      router
        .connect(user)
        .swapViaExecutor(
          await ctx.executor.getAddress(),
          signed,
          ctx.corridor.target as string,
          output,
          ctx.settlement.target as string,
          0n,
          user.address
        )
    ).to.be.revertedWithCustomError(ctx.executor, 'CallerNotPreferredFiller')
  })

  it('reverts the whole fill when the router receives less than minOut', async () => {
    const c = await deployEoaContext()
    const input = usdtUnits(100n)
    const output = cngnUnits(150n)
    const takerPays = output + feeOf(output)

    const maker = await fundedMaker(c, input)
    const { signed } = await signedMakerOrder(c, maker, {
      inputAmount: input,
      outputAmount: output,
      fillers: [await c.router.getAddress()],
    })
    await fundUser(c, takerPays)

    await expect(
      c.router
        .connect(c.user)
        .swapViaReactor(
          await c.reactor.getAddress(),
          [signed],
          await c.cngn.getAddress(),
          takerPays,
          await c.usdt.getAddress(),
          input + 1n,
          c.user.address
        )
    )
      .to.be.revertedWithCustomError(c.router, 'InsufficientOutput')
      .withArgs(input, input + 1n)
    expect(await c.usdt.balanceOf(maker.address)).to.equal(input)
  })
})
