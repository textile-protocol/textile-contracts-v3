import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { ethers, network } from 'hardhat'
import { privateKeyToAccount } from 'viem/accounts'

import {
  encodeLimitOrder,
  permit2Digest,
  type LimitOrderParams,
} from '../helpers/limitOrderPermit2'

const PERMIT2 = '0x000000000022D473030F116dDEE9F6B43aC78BA3'
const OP_KEY =
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d'
const MAX = (1n << 256n) - 1n
const INPUT_USDT = 100_000_000n
const OUTPUT_CNGN = 150n * 10n ** 18n
const FEE_CNGN = (OUTPUT_CNGN * 3n) / 10_000n

let nonceSeed = BigInt(Date.now())
const nextNonce = () => nonceSeed++

async function etchPermit2() {
  const code = readFileSync(
    join(__dirname, '../../../scripts/v3/fixtures/permit2-runtime.hex'),
    'utf8'
  ).trim()
  await network.provider.send('hardhat_setCode', [PERMIT2, code])
}

async function deploy() {
  await etchPermit2()
  const [trader, operator, owner, feeRecipient] = await ethers.getSigners()
  const Token = await ethers.getContractFactory('BlockableERC20Mock')
  const usdt = await Token.deploy('USD Tether', 'USDT', 6)
  const cngn = await Token.deploy('cNGN', 'cNGN', 18)
  await usdt.waitForDeployment()
  await cngn.waitForDeployment()

  const Reactor = await ethers.getContractFactory('LimitOrderReactor')
  const reactor = await Reactor.deploy(PERMIT2, await owner.getAddress())
  await reactor.waitForDeployment()

  const Controller = await ethers.getContractFactory('SellFirstFeeController')
  const controller = await Controller.deploy(await feeRecipient.getAddress(), 3)
  await controller.waitForDeployment()
  await reactor
    .connect(owner)
    .setProtocolFeeController(await controller.getAddress())

  return {
    trader,
    operator,
    owner,
    feeRecipient,
    usdt,
    cngn,
    reactor,
    controller,
  }
}

async function standardOrder(c: Awaited<ReturnType<typeof deploy>>) {
  const op = privateKeyToAccount(OP_KEY)
  const operatorA = await c.operator.getAddress()
  const o: LimitOrderParams = {
    reactor: (await c.reactor.getAddress()) as `0x${string}`,
    swapper: operatorA as `0x${string}`,
    nonce: nextNonce(),
    deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    inputToken: (await c.usdt.getAddress()) as `0x${string}`,
    inputAmount: INPUT_USDT,
    outputToken: (await c.cngn.getAddress()) as `0x${string}`,
    outputAmount: OUTPUT_CNGN,
    recipient: operatorA as `0x${string}`,
  }
  return {
    o,
    order: encodeLimitOrder(o),
    sig: await op.sign({ hash: permit2Digest(o, PERMIT2, 31337) }),
  }
}

describe('SellFirstFeeController', () => {
  it('deploys with the configured fee bps and recipient', async () => {
    const { controller, feeRecipient } = await deploy()
    expect(await controller.FEE_BPS()).to.equal(3n)
    expect(await controller.MAX_FEE_BPS()).to.equal(5n)
    expect(await controller.feeRecipient()).to.equal(
      await feeRecipient.getAddress()
    )
  })

  it('supports a different fee bps per deployment (e.g. 5 bps)', async () => {
    const [, , , feeRecipient] = await ethers.getSigners()
    const Controller = await ethers.getContractFactory('SellFirstFeeController')
    const controller = await Controller.deploy(
      await feeRecipient.getAddress(),
      5
    )
    await controller.waitForDeployment()
    expect(await controller.FEE_BPS()).to.equal(5n)
  })

  it('rejects a zero fee recipient', async () => {
    const Controller = await ethers.getContractFactory('SellFirstFeeController')
    await expect(
      Controller.deploy(ethers.ZeroAddress, 3)
    ).to.be.revertedWithCustomError(Controller, 'ZeroAddress')
  })

  it('rejects a fee bps of zero or above the reactor cap', async () => {
    const [, , , feeRecipient] = await ethers.getSigners()
    const Controller = await ethers.getContractFactory('SellFirstFeeController')
    const recipient = await feeRecipient.getAddress()
    await expect(Controller.deploy(recipient, 0))
      .to.be.revertedWithCustomError(Controller, 'InvalidFeeBps')
      .withArgs(0)
    await expect(Controller.deploy(recipient, 6))
      .to.be.revertedWithCustomError(Controller, 'InvalidFeeBps')
      .withArgs(6)
  })

  it('returns one native UniswapX output fee per output token', async () => {
    const { controller, reactor, operator, usdt, cngn, feeRecipient } =
      await deploy()
    const feeRecipientA = await feeRecipient.getAddress()
    const feeOutputs = await controller.getFeeOutputs({
      info: {
        reactor: await reactor.getAddress(),
        swapper: await operator.getAddress(),
        nonce: 1n,
        deadline: 2n,
        additionalValidationContract: ethers.ZeroAddress,
        additionalValidationData: '0x',
      },
      input: {
        token: await usdt.getAddress(),
        amount: INPUT_USDT,
        maxAmount: INPUT_USDT,
      },
      outputs: [
        {
          token: await cngn.getAddress(),
          amount: OUTPUT_CNGN,
          recipient: await operator.getAddress(),
        },
      ],
      sig: '0x',
      hash: ethers.ZeroHash,
    })

    expect(feeOutputs).to.deep.equal([
      [await cngn.getAddress(), FEE_CNGN, feeRecipientA],
    ])
  })

  it('aggregates same-token outputs before applying 3 bps', async () => {
    const { controller, reactor, operator, usdt, cngn, feeRecipient } =
      await deploy()
    const feeOutputs = await controller.getFeeOutputs({
      info: {
        reactor: await reactor.getAddress(),
        swapper: await operator.getAddress(),
        nonce: 1n,
        deadline: 2n,
        additionalValidationContract: ethers.ZeroAddress,
        additionalValidationData: '0x',
      },
      input: {
        token: await usdt.getAddress(),
        amount: INPUT_USDT,
        maxAmount: INPUT_USDT,
      },
      outputs: [
        {
          token: await cngn.getAddress(),
          amount: 1_999n,
          recipient: await operator.getAddress(),
        },
        {
          token: await cngn.getAddress(),
          amount: 1_999n,
          recipient: await operator.getAddress(),
        },
      ],
      sig: '0x',
      hash: ethers.ZeroHash,
    })

    expect(feeOutputs).to.deep.equal([
      [await cngn.getAddress(), 1n, await feeRecipient.getAddress()],
    ])
  })

  it('rejects a nonzero output whose 3 bps fee would round to zero', async () => {
    const { controller, reactor, operator, usdt, cngn } = await deploy()
    const token = await cngn.getAddress()
    await expect(
      controller.getFeeOutputs({
        info: {
          reactor: await reactor.getAddress(),
          swapper: await operator.getAddress(),
          nonce: 1n,
          deadline: 2n,
          additionalValidationContract: ethers.ZeroAddress,
          additionalValidationData: '0x',
        },
        input: {
          token: await usdt.getAddress(),
          amount: INPUT_USDT,
          maxAmount: INPUT_USDT,
        },
        outputs: [
          { token, amount: 1_999n, recipient: await operator.getAddress() },
        ],
        sig: '0x',
        hash: ethers.ZeroHash,
      })
    )
      .to.be.revertedWithCustomError(controller, 'FeeRoundsToZero')
      .withArgs(token, 1_999n)
  })

  it('charges 3 bps through the reactor native ProtocolFees hook', async () => {
    const c = await deploy()
    const traderA = await c.trader.getAddress()
    const operatorA = await c.operator.getAddress()
    const feeRecipientA = await c.feeRecipient.getAddress()
    const { order, sig } = await standardOrder(c)

    await c.usdt.mint(operatorA, INPUT_USDT)
    await c.cngn.mint(traderA, OUTPUT_CNGN + FEE_CNGN)
    await c.usdt.connect(c.operator).approve(PERMIT2, MAX)
    await c.cngn.connect(c.trader).approve(await c.reactor.getAddress(), MAX)

    await c.reactor.connect(c.trader).executeBatch([{ order, sig }])

    expect(await c.usdt.balanceOf(operatorA)).to.equal(0n)
    expect(await c.usdt.balanceOf(traderA)).to.equal(INPUT_USDT)
    expect(await c.cngn.balanceOf(operatorA)).to.equal(OUTPUT_CNGN)
    expect(await c.cngn.balanceOf(feeRecipientA)).to.equal(FEE_CNGN)
    expect(await c.cngn.balanceOf(traderA)).to.equal(0n)
  })
})
