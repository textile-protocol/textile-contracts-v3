import { expect } from 'chai'
import { AbiCoder } from 'ethers'
import { ethers } from 'hardhat'

import {
  ERC1271_FAIL,
  ERC1271_MAGIC,
  deployOperatorVault,
  signDigest,
  usdt,
  cngn,
} from './fixtures/operatorVault.fixture'
import { closeRedeem, seedShares } from './helpers/vaultLifecycle'
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

  // The vault only ever signs a fixed-input order. `maxAmount` is what Permit2
  // is allowed to pull, `amount` is what the reactor requests, and a spread
  // between them is a partial-fill order the policy never priced. It used to
  // be refused only because `VaultLib.permit2Digest` rebuilds the permit with
  // `amount`; now the policy says so (audit v0.3 N-06).
  it('rejects an order whose maxAmount differs from its amount', async function () {
    const ctx = await funded()
    const order = baseOrder(ctx)

    for (const inputMaxAmount of [usdt(101n), usdt(99n)]) {
      const { hash, signature } = await signVaultEnvelope(ctx.strategy, ctx.risk, {
        ...order,
        inputMaxAmount,
      })
      // The digest is built from `amount`, so this reaches the policy check
      // rather than stopping at the digest comparison.
      expect(
        await ctx.vault.isValidSignature(hash, signature),
        `maxAmount ${inputMaxAmount} should not be accepted`
      ).to.equal(ERC1271_FAIL)
    }

    const equal = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      ...order,
      inputMaxAmount: order.inputAmount,
    })
    expect(await ctx.vault.isValidSignature(equal.hash, equal.signature)).to.equal(ERC1271_MAGIC)
  })

  // VaultPolicy:344 — an input token that is neither pair leg leaves both
  // quotable figures at zero and never matches a direction (audit v0.3 N-14).
  it('rejects an envelope whose input token is neither pair asset', async function () {
    const ctx = await funded()
    const Foreign = await ethers.getContractFactory('ERC20Mock')
    const foreign = await Foreign.deploy('FOREIGN', 'FGN', 6)

    const { hash, signature } = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      ...baseOrder(ctx),
      inputToken: await foreign.getAddress(),
    })
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_FAIL)
  })

  // VaultPolicy:329 — the length check runs before the digest comparison, so
  // this is refused on shape alone (audit v0.3 N-14).
  it('rejects an envelope carrying two outputs', async function () {
    const ctx = await funded()
    const order = baseOrder(ctx)
    const { hash, params } = await signVaultEnvelope(ctx.strategy, ctx.risk, order)
    const vaultAddress = ctx.vault.target as string

    const twoOutputs = AbiCoder.defaultAbiCoder().encode(
      [
        'tuple(tuple(address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData) info,tuple(address token,uint256 amount,uint256 maxAmount) input,tuple(address token,uint256 amount,address recipient)[] outputs)',
        'bytes',
        'bytes',
      ],
      [
        {
          info: {
            reactor: params.reactor,
            swapper: params.swapper,
            nonce: params.nonce,
            deadline: params.deadline,
            additionalValidationContract: params.additionalValidationContract,
            additionalValidationData: params.additionalValidationData,
          },
          input: {
            token: params.inputToken,
            amount: params.inputAmount,
            maxAmount: params.inputAmount,
          },
          outputs: [
            { token: params.outputToken, amount: params.outputAmount, recipient: vaultAddress },
            { token: params.outputToken, amount: 1n, recipient: vaultAddress },
          ],
        },
        await signDigest(ctx.strategy, hash),
        await signDigest(ctx.risk, hash),
      ]
    )
    expect(await ctx.vault.isValidSignature(hash, twoOutputs)).to.equal(ERC1271_FAIL)
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
    await closeRedeem(ctx, redeemId)
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
    await closeRedeem(ctx, redeemId)
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
