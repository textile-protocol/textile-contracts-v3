import { expect } from 'chai'
import { AbiCoder } from 'ethers'
import { ethers } from 'hardhat'

import { DAY, PRICE_1, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { encodeValidationData, freshAttestation, signAttestation } from './helpers/vaultSignatures'

describe('VaultPolicy', function () {
  it('rejects a zero-price or expired attestation', async function () {
    const ctx = await deployOperatorVault()
    const att = await freshAttestation(ctx.vault, 1n, 0n)
    const sig = await signAttestation(ctx.harness, ctx.risk, { ...att, corridorAssetPrice: PRICE_1 })
    await expect(
      ctx.harness.verifyAttestation(att, sig, 1n, await ctx.vault.getAddress(), ctx.risk.address)
    ).to.be.reverted

    const expired = await freshAttestation(ctx.vault, 1n, PRICE_1)
    expired.validUntil = expired.validAfter
    const expiredSig = await signAttestation(ctx.harness, ctx.risk, expired)
    await expect(
      ctx.harness.verifyAttestation(
        expired,
        expiredSig,
        1n,
        await ctx.vault.getAddress(),
        ctx.risk.address
      )
    ).to.be.reverted
  })

  it('accepts a well-formed attestation', async function () {
    const ctx = await deployOperatorVault()
    const att = await freshAttestation(ctx.vault, 1n, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)
    expect(
      await ctx.harness.verifyAttestation(
        att,
        sig,
        1n,
        await ctx.vault.getAddress(),
        ctx.risk.address
      )
    ).to.equal(PRICE_1)
  })

  it('rejects orders that fail policy checks', async function () {
    const ctx = await deployOperatorVault()
    const vaultAddr = await ctx.vault.getAddress()
    const deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp + 600)
    const ctxPolicy = {
      reactor: ctx.reactor,
      vault: vaultAddr,
      preferredFillerValidation: ctx.preferredFiller,
      tradingEpoch: 1n,
      maxOrderLifetime: 7200n,
      settlementAsset: await ctx.settlement.getAddress(),
      corridorAsset: await ctx.corridor.getAddress(),
      maxOrderInputSettlement: usdt(100n),
      maxOrderInputCorridor: usdt(100n),
      quotableSettlement: usdt(50n),
      quotableCorridor: usdt(50n),
      closeOnly: false,
    }
    const order = {
      info: {
        reactor: ctx.reactor,
        swapper: vaultAddr,
        nonce: 1n << 128n,
        deadline,
        additionalValidationContract: ctx.preferredFiller,
        additionalValidationData: encodeValidationData(ctx.other.address, deadline),
      },
      input: {
        token: await ctx.settlement.getAddress(),
        amount: usdt(10n),
        maxAmount: usdt(10n),
      },
      outputs: [
        {
          token: await ctx.corridor.getAddress(),
          amount: usdt(10n),
          recipient: vaultAddr,
        },
      ],
    }
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(true)
    expect(
      await ctx.harness.orderPolicyOk(order, {
        ...ctxPolicy,
        maxOrderLifetime: 2n ** 256n - 1n,
      })
    ).to.equal(true)

    order.outputs[0].recipient = ctx.other.address
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.outputs[0].recipient = vaultAddr

    order.info.additionalValidationData = AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint256'],
      [[], deadline]
    )
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.additionalValidationData = encodeValidationData(ctx.other.address, deadline)

    order.info.reactor = ctx.other.address
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.reactor = ctx.reactor

    order.info.swapper = ctx.other.address
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.swapper = vaultAddr

    order.info.additionalValidationContract = ctx.other.address
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.additionalValidationContract = ctx.preferredFiller

    order.info.nonce = 2n << 128n
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.nonce = 1n << 128n

    order.info.deadline = BigInt((await ethers.provider.getBlock('latest'))!.timestamp - 1)
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.deadline = deadline + 10_000n
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.deadline = deadline

    order.outputs = []
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.outputs = [
      { token: await ctx.corridor.getAddress(), amount: 0n, recipient: vaultAddr },
    ]
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.outputs = [
      {
        token: await ctx.settlement.getAddress(),
        amount: usdt(10n),
        recipient: vaultAddr,
      },
    ]
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.outputs = [
      {
        token: await ctx.corridor.getAddress(),
        amount: usdt(10n),
        recipient: vaultAddr,
      },
    ]

    order.input.amount = usdt(60n)
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.input.amount = usdt(10n)

    const closeOnly = { ...ctxPolicy, closeOnly: true }
    expect(await ctx.harness.orderPolicyOk(order, closeOnly)).to.equal(false)

    const earlyBind = {
      ...order,
      info: {
        ...order.info,
        additionalValidationData: encodeValidationData(ctx.other.address, deadline - 1n),
      },
    }
    expect(await ctx.harness.orderPolicyOk(earlyBind, ctxPolicy)).to.equal(false)

    order.input.amount = 0n
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.input.amount = usdt(10n)

    order.input.token = await ctx.corridor.getAddress()
    order.outputs[0].token = await ctx.settlement.getAddress()
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(true)
    expect(await ctx.harness.orderPolicyOk(order, closeOnly)).to.equal(true)

    order.input.amount = usdt(60n)
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.input.amount = usdt(10n)

    const tooMany = Array.from({ length: 11 }, () => ctx.other.address)
    order.info.additionalValidationData = AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint256'],
      [tooMany, deadline]
    )
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)

    order.info.additionalValidationData = AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint256'],
      [[ethers.ZeroAddress], deadline]
    )
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(false)
    order.info.additionalValidationData = encodeValidationData(ctx.other.address, deadline)
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(true)
  })

  it('rejects attestations with the wrong vault, chain, epoch, window, or signer', async function () {
    const ctx = await deployOperatorVault()
    const vaultAddr = await ctx.vault.getAddress()
    const att = await freshAttestation(ctx.vault, 1n, PRICE_1)
    const sig = await signAttestation(ctx.harness, ctx.risk, att)

    await expect(ctx.harness.verifyAttestation(att, sig, 2n, vaultAddr, ctx.risk.address)).to.be
      .reverted
    await expect(ctx.harness.verifyAttestation(att, sig, 1n, ctx.other.address, ctx.risk.address)).to
      .be.reverted
    await expect(ctx.harness.verifyAttestation(att, sig, 1n, vaultAddr, ctx.strategy.address)).to.be
      .reverted

    const future = { ...att, validAfter: att.validUntil }
    const futureSig = await signAttestation(ctx.harness, ctx.risk, future)
    await expect(
      ctx.harness.verifyAttestation(future, futureSig, 1n, vaultAddr, ctx.risk.address)
    ).to.be.reverted

    const wrongChain = { ...att, chainId: att.chainId + 1n }
    const wrongChainSig = await signAttestation(ctx.harness, ctx.risk, wrongChain)
    await expect(
      ctx.harness.verifyAttestation(wrongChain, wrongChainSig, 1n, vaultAddr, ctx.risk.address)
    ).to.be.reverted
  })

  it('rejects a config with a zero duration, size, or version', async function () {
    const ctx = await deployOperatorVault()
    const cfg = {
      settlementAsset: await ctx.settlement.getAddress(),
      corridorAsset: await ctx.corridor.getAddress(),
      reactor: ctx.reactor,
      permit2: ctx.permit2,
      preferredFillerValidation: ctx.preferredFiller,
      operatorAdmin: ctx.operatorAdmin.address,
      strategySigner: ctx.strategy.address,
      riskAdmin: ctx.riskAdmin.address,
      riskSigner: ctx.risk.address,
      guardian: ctx.guardian.address,
      feeRecipient: ctx.feeRecipient.address,
      maxOrderInputSettlement: usdt(100n),
      maxOrderInputCorridor: usdt(100n),
      minReserveSettlement: 0n,
      minReserveCorridor: 0n,
      maxOrderLifetime: 3600n,
      depositEpochDuration: DAY,
      redemptionEpochDuration: DAY,
      redemptionCloseCooldown: DAY,
      inKindExitTimeout: DAY,
      emergencyExitTimeout: 7 * DAY,
      valuationTimeout: DAY,
      managementFeeWad: 0n,
      riskSignerDelay: DAY,
      minDepositAssets: usdt(1n),
      minRedeemShares: usdt(1n),
      yieldAdapter: ethers.ZeroAddress,
      minLiquidSettlement: 0n,
      version: 1n,
    }
    await expect(ctx.harness.validateConfig({ ...cfg, depositEpochDuration: 0n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, depositEpochDuration: 2n ** 64n })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, redemptionEpochDuration: 0n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, redemptionEpochDuration: 2n ** 64n })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, redemptionCloseCooldown: 0n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, redemptionCloseCooldown: 2n ** 64n })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, inKindExitTimeout: 0n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, inKindExitTimeout: 2n ** 64n })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, emergencyExitTimeout: 0n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, emergencyExitTimeout: cfg.inKindExitTimeout })
    ).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, emergencyExitTimeout: BigInt(cfg.inKindExitTimeout) - 1n })
    ).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, emergencyExitTimeout: 2n ** 64n })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, valuationTimeout: 0n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, valuationTimeout: 2n ** 64n })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, riskSignerDelay: 0n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, riskSignerDelay: 2n ** 64n })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, minDepositAssets: 0n })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, minRedeemShares: 0n })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, version: 0n })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, maxOrderLifetime: 0n })).to.be.reverted
    // A liquid floor makes no sense without a yield adapter.
    await expect(ctx.harness.validateConfig({ ...cfg, minLiquidSettlement: 1n })).to.be.reverted
    await expect(
      ctx.harness.validateConfig({
        ...cfg,
        yieldAdapter: ctx.other.address,
        minLiquidSettlement: 1n,
      })
    ).to.not.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, maxOrderInputSettlement: 0n })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, maxOrderInputCorridor: 0n })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, settlementAsset: ethers.ZeroAddress })).to.be
      .reverted
    await expect(ctx.harness.validateConfig({ ...cfg, corridorAsset: ethers.ZeroAddress })).to.be
      .reverted
    await expect(ctx.harness.validateConfig({ ...cfg, permit2: ethers.ZeroAddress })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, reactor: ethers.ZeroAddress })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, strategySigner: ethers.ZeroAddress })).to.be
      .reverted
    await expect(
      ctx.harness.validateConfig({ ...cfg, riskSigner: cfg.strategySigner })
    ).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, riskAdmin: ethers.ZeroAddress })).to.be
      .reverted
    await expect(ctx.harness.validateConfig({ ...cfg, riskSigner: ethers.ZeroAddress })).to.be
      .reverted
    await expect(ctx.harness.validateConfig({ ...cfg, guardian: ethers.ZeroAddress })).to.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, feeRecipient: ethers.ZeroAddress })).to.be
      .reverted
    await expect(ctx.harness.validateConfig({ ...cfg, preferredFillerValidation: ethers.ZeroAddress }))
      .to.be.reverted
    await expect(ctx.harness.validateConfig(cfg)).to.not.be.reverted
    await expect(ctx.harness.validateConfig({ ...cfg, managementFeeWad: 10n ** 17n })).to.not.be
      .reverted
  })
})
