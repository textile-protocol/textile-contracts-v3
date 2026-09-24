import { loadFixture } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { AbiCoder } from 'ethers'
import { ethers } from 'hardhat'

import * as math from '../../../constants/src/operatorVaultMath'

import { DAY, PRICE_1, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { closeDeposit } from './helpers/vaultLifecycle'
import {
  attestationSignatures,
  encodeValidationData,
  freshAttestation,
  signAttestation,
} from './helpers/vaultSignatures'

/** A config `validateConfig` accepts, for tests that break one field at a time. */
async function validConfig(ctx: Awaited<ReturnType<typeof deployOperatorVault>>) {
  return {
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
    emergencyExitTimeout: 7 * DAY,
    valuationTimeout: DAY,
    managementFeeWad: 0n,
    performanceFeeWad: 0n,
    riskSignerDelay: DAY,
    minDepositAssets: usdt(1n),
    minDepositCorridor: 0n,
    minRedeemShares: usdt(1n),
    yieldAdapter: ethers.ZeroAddress,
    minLiquidSettlement: 0n,
    perfFloorEnabled: false,
  }
}

/** A vault whose epoch 1 is closed, so `verifyAttestation` has a deadline to check against. */
async function deployWithClosedEpoch() {
  const ctx = await deployOperatorVault()
  await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
  await closeDeposit(ctx)
  return ctx
}

describe('VaultPolicy', function () {
  describe('constructor validation errors', function () {
    const requiredAddresses = [
      'settlementAsset',
      'corridorAsset',
      'reactor',
      'permit2',
      'preferredFillerValidation',
      'operatorAdmin',
      'strategySigner',
      'riskAdmin',
      'riskSigner',
      'guardian',
      'feeRecipient',
    ] as const
    const positiveLimits = [
      'maxOrderInputSettlement',
      'maxOrderInputCorridor',
      'maxOrderLifetime',
      'depositEpochDuration',
      'redemptionEpochDuration',
      'redemptionCloseCooldown',
      'emergencyExitTimeout',
      'valuationTimeout',
      'riskSignerDelay',
      'minDepositAssets',
      'minRedeemShares',
    ] as const

    for (const field of requiredAddresses) {
      it(`reports ZeroAddress for ${field}`, async function () {
        const ctx = await loadFixture(deployOperatorVault)
        const cfg = await validConfig(ctx)
        await expect(
          ctx.harness.validateConfig({ ...cfg, [field]: ethers.ZeroAddress })
        ).to.be.revertedWithCustomError(ctx.vault, 'ZeroAddress')
      })
    }

    for (const field of positiveLimits) {
      it(`reports InvalidParams for a zero ${field}`, async function () {
        const ctx = await loadFixture(deployOperatorVault)
        const cfg = await validConfig(ctx)
        await expect(
          ctx.harness.validateConfig({ ...cfg, [field]: 0n })
        ).to.be.revertedWithCustomError(ctx.vault, 'InvalidParams')
      })
    }

    it('preserves error precedence when several fields are invalid', async function () {
      const ctx = await loadFixture(deployOperatorVault)
      const cfg = await validConfig(ctx)
      // Same assets and overlapping signers must not hide a missing required address.
      await expect(
        ctx.harness.validateConfig({
          ...cfg,
          corridorAsset: cfg.settlementAsset,
          riskSigner: cfg.strategySigner,
          feeRecipient: ethers.ZeroAddress,
        })
      ).to.be.revertedWithCustomError(ctx.vault, 'ZeroAddress')
      await expect(
        ctx.harness.validateConfig({
          ...cfg,
          corridorAsset: cfg.settlementAsset,
          riskSigner: cfg.strategySigner,
          maxOrderLifetime: 0n,
        })
      ).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
      // This address cannot answer decimals(); pure validation must fail first.
      await expect(
        ctx.harness.validateConfig({
          ...cfg,
          settlementAsset: ctx.other.address,
          managementFeeWad: math.MAX_MANAGEMENT_FEE_WAD + 1n,
        })
      ).to.be.revertedWithCustomError(ctx.vault, 'InvalidParams')
    })

    it('keeps optional zero settings and an uncapped order lifetime valid', async function () {
      const ctx = await loadFixture(deployOperatorVault)
      const cfg = await validConfig(ctx)
      await expect(
        ctx.harness.validateConfig({
          ...cfg,
          maxOrderLifetime: ethers.MaxUint256,
          minReserveSettlement: 0n,
          minReserveCorridor: 0n,
          managementFeeWad: 0n,
          performanceFeeWad: 0n,
          minDepositCorridor: 0n,
          yieldAdapter: ethers.ZeroAddress,
          minLiquidSettlement: 0n,
        })
      ).not.to.be.reverted
    })
  })

  it('rejects a zero-price or expired attestation', async function () {
    const ctx = await deployWithClosedEpoch()
    const vaultAddr = await ctx.vault.getAddress()
    const att = await freshAttestation(ctx.vault, 1n, 0n)
    const sigs = await attestationSignatures(ctx, { ...att, corridorAssetPrice: PRICE_1 })
    await expect(ctx.harness.verifyAttestation(att, ...sigs, 1n, vaultAddr)).to.be.reverted

    const expired = await freshAttestation(ctx.vault, 1n, PRICE_1)
    expired.validUntil = expired.validAfter
    const expiredSigs = await attestationSignatures(ctx, expired)
    await expect(ctx.harness.verifyAttestation(expired, ...expiredSigs, 1n, vaultAddr)).to.be
      .reverted
  })

  it('accepts a well-formed attestation', async function () {
    const ctx = await deployWithClosedEpoch()
    const att = await freshAttestation(ctx.vault, 1n, PRICE_1)
    const sigs = await attestationSignatures(ctx, att)
    expect(
      await ctx.harness.verifyAttestation(att, ...sigs, 1n, await ctx.vault.getAddress())
    ).to.equal(PRICE_1)
  })

  it('needs both signatures: either key alone is refused', async function () {
    const ctx = await deployWithClosedEpoch()
    const vaultAddr = await ctx.vault.getAddress()
    const att = await freshAttestation(ctx.vault, 1n, PRICE_1)
    const [strategySig, riskSig] = await attestationSignatures(ctx, att)
    const verify = (s: string, r: string) => ctx.harness.verifyAttestation(att, s, r, 1n, vaultAddr)
    const refused = (s: string, r: string) =>
      expect(verify(s, r)).to.be.revertedWithCustomError(ctx.vault, 'InvalidAttestation')

    // One key in both slots, and the two swapped.
    await refused(riskSig, riskSig)
    await refused(strategySig, strategySig)
    await refused(riskSig, strategySig)
    // A stranger in either slot.
    const otherSig = await signAttestation(ctx.harness, ethers.Wallet.createRandom(), att)
    await refused(otherSig, riskSig)
    await refused(strategySig, otherSig)
    expect(await verify(strategySig, riskSig)).to.equal(PRICE_1)
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
        additionalValidationData: encodeValidationData([ctx.other.address], deadline),
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
    order.info.additionalValidationData = encodeValidationData([ctx.other.address], deadline)

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
        additionalValidationData: encodeValidationData([ctx.other.address], deadline - 1n),
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
    order.info.additionalValidationData = encodeValidationData([ctx.other.address], deadline)
    expect(await ctx.harness.orderPolicyOk(order, ctxPolicy)).to.equal(true)
  })

  it('rejects attestations with the wrong vault, chain, epoch, window, or signer', async function () {
    const ctx = await deployWithClosedEpoch()
    const vaultAddr = await ctx.vault.getAddress()
    const att = await freshAttestation(ctx.vault, 1n, PRICE_1)
    const sigs = await attestationSignatures(ctx, att)

    await expect(ctx.harness.verifyAttestation(att, ...sigs, 2n, vaultAddr)).to.be.reverted
    await expect(ctx.harness.verifyAttestation(att, ...sigs, 1n, ctx.other.address)).to.be.reverted

    const future = { ...att, validAfter: att.validUntil }
    const futureSigs = await attestationSignatures(ctx, future)
    await expect(ctx.harness.verifyAttestation(future, ...futureSigs, 1n, vaultAddr)).to.be.reverted

    const wrongChain = { ...att, chainId: att.chainId + 1n }
    const wrongChainSigs = await attestationSignatures(ctx, wrongChain)
    await expect(ctx.harness.verifyAttestation(wrongChain, ...wrongChainSigs, 1n, vaultAddr)).to.be
      .reverted

    // Correctly signed, but for an epoch that never closed.
    const unclosed = { ...att, epochId: 2n }
    const unclosedSigs = await attestationSignatures(ctx, unclosed)
    await expect(
      ctx.harness.verifyAttestation(unclosed, ...unclosedSigs, 2n, vaultAddr)
    ).to.be.revertedWithCustomError(ctx.vault, 'InvalidAttestation')
  })

  it('rejects a config with a zero duration or size', async function () {
    const ctx = await deployOperatorVault()
    const cfg = await validConfig(ctx)
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
    await expect(ctx.harness.validateConfig({ ...cfg, emergencyExitTimeout: 0n })).to.be.reverted
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
    for (const [field, cap] of [
      ['managementFeeWad', math.MAX_MANAGEMENT_FEE_WAD],
      ['performanceFeeWad', math.MAX_PERFORMANCE_FEE_WAD],
    ] as const) {
      await expect(ctx.harness.validateConfig({ ...cfg, [field]: cap })).to.not.be.reverted
      await expect(ctx.harness.validateConfig({ ...cfg, [field]: cap + 1n })).to.be.reverted
    }
  })

  // The emergency exit is permissionless and pauses the vault, so a vault
  // whose exit timeout undercuts its own valuation window hands anyone a
  // pause every time a redeem epoch closes (audit v0.3 N-04).
  it('refuses an emergency exit that opens before the valuation window shuts', async function () {
    const ctx = await deployOperatorVault()
    const cfg = await validConfig(ctx)

    for (const emergencyExitTimeout of [DAY - 1, DAY]) {
      await expect(
        ctx.harness.validateConfig({ ...cfg, emergencyExitTimeout, valuationTimeout: DAY }),
        `emergencyExitTimeout ${emergencyExitTimeout} should not be accepted`
      ).to.be.reverted
    }
    await expect(
      ctx.harness.validateConfig({ ...cfg, emergencyExitTimeout: DAY + 1, valuationTimeout: DAY })
    ).to.not.be.reverted
  })

  // The ceiling is what lets the vault add a duration to `block.timestamp` and
  // cast to uint64 without a runtime check (audit v0.3 N-07).
  it('caps every configured duration at half the uint64 range', async function () {
    const ctx = await deployOperatorVault()
    const cfg = await validConfig(ctx)
    const max = (2n ** 64n - 1n) / 2n

    for (const field of [
      'depositEpochDuration',
      'redemptionEpochDuration',
      'redemptionCloseCooldown',
      'emergencyExitTimeout',
      'valuationTimeout',
      'riskSignerDelay',
    ] as const) {
      await expect(
        ctx.harness.validateConfig({ ...cfg, [field]: max + 1n }),
        `${field} should refuse one past the ceiling`
      ).to.be.reverted
    }

    // The ceiling itself is accepted. `valuationTimeout` is the one that
    // cannot sit at it, since the exit timeout has to clear it.
    for (const field of [
      'depositEpochDuration',
      'redemptionEpochDuration',
      'redemptionCloseCooldown',
      'emergencyExitTimeout',
      'riskSignerDelay',
    ] as const) {
      await expect(
        ctx.harness.validateConfig({ ...cfg, [field]: max }),
        `${field} should accept the ceiling`
      ).to.not.be.reverted
    }
    await expect(
      ctx.harness.validateConfig({
        ...cfg,
        valuationTimeout: max - 1n,
        emergencyExitTimeout: max,
      })
    ).to.not.be.reverted
  })

  it('deploys no vault whose emergency exit undercuts its valuation timeout', async function () {
    await expect(
      deployOperatorVault({ emergencyExitTimeout: DAY, valuationTimeout: DAY })
    ).to.be.reverted
  })
})
