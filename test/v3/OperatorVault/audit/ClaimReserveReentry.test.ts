/**
 * Regression — a claim's payout callback could spend another redeemer's corridor
 *
 * `claim()` used to release both reserves (`reservedSettlement`,
 * `reservedCorridor`) before either transfer. With a settlement asset that
 * calls the receiver back on transfer, the receiver ran while its corridor
 * reserve was already released but the corridor tokens were still in the
 * vault. `_freeCorridor()` over-reported by that claim's corridor payout,
 * `isValidSignature` (a view, so outside `nonReentrant`) validated fills
 * against the inflated figure, and an order sized to the pre-settle quotable
 * filled from inside the callback. The vault ended with less corridor than it
 * owed a different redeemer, and every path through `_freeCorridor` reverted.
 *
 * Found in the 2026-09-22 FX stack audit
 * (docs/audits/2026-09-22-fx-stack, `OperatorVault.claim:reserve-release-before-transfer-reentrancy`).
 *
 * Remediation, two independent layers:
 *   1. `isValidSignature` refuses while a guarded entry point is on the stack.
 *   2. `claim()` releases each reserve right before that asset moves, so the
 *      views stay honest inside any transfer callback.
 */
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { CANONICAL_PERMIT2, etchPermit2 } from '../../helpers/etchPermit2'
import { encodeLimitOrder } from '../../helpers/limitOrderPermit2'
import {
  DAY,
  ERC1271_FAIL,
  ERC1271_MAGIC,
  PRICE_1,
  cngn,
  defaultInit,
  usdt,
  vaultSigners,
} from '../fixtures/operatorVault.fixture'
import {
  attestationSignatures,
  freshAttestation,
  signVaultEnvelope,
} from '../helpers/vaultSignatures'

/** A vault whose settlement asset calls the receiver back on transfer. */
async function deployCallbackVault() {
  const s = await vaultSigners()
  const Hook = await ethers.getContractFactory('RecvHookERC20Mock')
  const settlement = await Hook.deploy('USDH', 'USDH', 6)
  const Plain = await ethers.getContractFactory('ERC20Mock')
  const corridor = await Plain.deploy('cNGN', 'cNGN', 18)

  await etchPermit2()
  const Reactor = await ethers.getContractFactory('LimitOrderReactor')
  const reactor = await (
    await Reactor.deploy(CANONICAL_PERMIT2, s.deployer.address)
  ).getAddress()
  const Validation = await ethers.getContractFactory('PreferredFillerValidation')
  const preferredFiller = await (await Validation.deploy()).getAddress()

  const Policy = await ethers.getContractFactory('VaultPolicy')
  const vaultPolicy = await (await Policy.deploy()).getAddress()
  const Deployer = await ethers.getContractFactory('VaultDeployer', {
    libraries: { VaultPolicy: vaultPolicy },
  })
  const vaultDeployer = await (await Deployer.deploy()).getAddress()
  const Factory = await ethers.getContractFactory('OperatorVaultFactory', {
    libraries: { VaultDeployer: vaultDeployer },
  })
  const factory = await Factory.deploy(
    reactor,
    CANONICAL_PERMIT2,
    preferredFiller,
    ethers.ZeroAddress,
    s.protocolFeeRecipient.address
  )

  const init = defaultInit(s)
  init.settlementAsset = await settlement.getAddress()
  init.corridorAsset = await corridor.getAddress()
  const receipt = await (
    await factory.connect(s.operatorAdmin).deployVault(init)
  ).wait()
  const deployed = receipt!.logs
    .map((l) => {
      try {
        return factory.interface.parseLog(l)
      } catch {
        return null
      }
    })
    .find((p) => p?.name === 'VaultDeployed')
  const vault = await ethers.getContractAt('OperatorVault', deployed!.args.vault)

  const Harness = await ethers.getContractFactory('VaultLibHarness', {
    libraries: { VaultPolicy: vaultPolicy },
  })
  const harness = await Harness.deploy()

  for (const lp of [s.lp1, s.lp2]) {
    await settlement.mint(lp.address, usdt(1_000_000n))
    await corridor.mint(lp.address, cngn(1_000_000n))
    await settlement.connect(lp).approve(await vault.getAddress(), ethers.MaxUint256)
    await corridor.connect(lp).approve(await vault.getAddress(), ethers.MaxUint256)
  }
  return { ...s, settlement, corridor, vault, harness, reactor, preferredFiller }
}

type Ctx = Awaited<ReturnType<typeof deployCallbackVault>>

async function settleWithFreshAttestation(
  ctx: Ctx,
  epochId: bigint,
  kind: 'deposit' | 'redeem'
) {
  const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
  const sigs = await attestationSignatures(ctx, att)
  if (kind === 'deposit') await ctx.vault.processDepositEpoch(epochId, att, ...sigs)
  else await ctx.vault.settleRedeemEpoch(epochId, att, ...sigs)
}

/**
 * 20,000 USDH and 20,000 cNGN in the vault; lp1's redeem epoch A settled and
 * left unclaimed (2,500 cNGN reserved for lp1); the probe's epoch B closed.
 */
async function stageTwoRedeemers(ctx: Ctx) {
  const vaultAddr = await ctx.vault.getAddress()

  await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(20_000n), ctx.lp1.address, ctx.lp1.address)
  const dep1 = await ctx.vault.currentDepositEpochId()
  await time.increase(DAY)
  await ctx.vault.closeDepositEpoch(dep1)
  await settleWithFreshAttestation(ctx, dep1, 'deposit')
  await ctx.vault.connect(ctx.lp1).claim(dep1, ctx.lp1.address, ctx.lp1.address)

  await ctx.vault
    .connect(ctx.lp2)
    .requestDepositCorridor(cngn(20_000n), ctx.lp2.address, ctx.lp2.address)
  const dep2 = await ctx.vault.currentCorridorDepositEpochId()
  await time.increase(DAY)
  await ctx.vault.closeDepositEpoch(dep2)
  await settleWithFreshAttestation(ctx, dep2, 'deposit')
  await ctx.vault.connect(ctx.lp2).claim(dep2, ctx.lp2.address, ctx.lp2.address)

  const Probe = await ethers.getContractFactory('ClaimReentryProbe')
  const probe = await Probe.deploy()
  await probe.init(vaultAddr, ctx.reactor)
  await ctx.vault.connect(ctx.lp2).transfer(await probe.getAddress(), usdt(5_000n))

  // Victim epoch A.
  await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(5_000n), ctx.lp1.address, ctx.lp1.address)
  const epochA = await ctx.vault.currentRedeemEpochId()
  await time.increase(DAY)
  await ctx.vault.connect(ctx.operatorAdmin).closeRedeemEpoch(epochA)
  await settleWithFreshAttestation(ctx, epochA, 'redeem')

  // Probe's epoch B, closed but not yet settled.
  await probe.requestRedeem(usdt(5_000n))
  const epochB = await ctx.vault.currentRedeemEpochId()
  await time.increase(DAY)
  await ctx.vault.connect(ctx.operatorAdmin).closeRedeemEpoch(epochB)

  return { vaultAddr, probe, epochA, epochB }
}

/** A fairly priced corridor-sell order with the probe as the only filler. */
async function signCorridorSell(
  ctx: Ctx,
  vaultAddr: string,
  taker: string,
  inputAmount: bigint
) {
  const block = await ethers.provider.getBlock('latest')
  const order = {
    reactor: ctx.reactor,
    vault: vaultAddr,
    permit2: CANONICAL_PERMIT2,
    chainId: 31337,
    nonce: ((await ctx.vault.tradingEpoch()) << 128n) | 7n,
    deadline: BigInt(block!.timestamp + 3600),
    inputToken: await ctx.corridor.getAddress(),
    inputAmount,
    outputToken: await ctx.settlement.getAddress(),
    // PRICE_1: one cNGN (18dp) is worth one USDH (6dp).
    outputAmount: inputAmount / 10n ** 12n,
    preferredFiller: ctx.preferredFiller,
    taker,
  }
  const signed = await signVaultEnvelope(ctx.strategy, ctx.risk, order)
  return { ...signed, outputAmount: order.outputAmount }
}

describe('a claim payout callback cannot spend another redeemer’s corridor', function () {
  it('refuses the in-callback fill and leaves the other redeemer’s reserve intact', async function () {
    const ctx = await deployCallbackVault()
    const { vaultAddr, probe, epochA, epochB } = await stageTwoRedeemers(ctx)
    const probeAddr = await probe.getAddress()

    // Signed in good faith for the whole quotable (17,500 cNGN) while B is
    // closed. Settling B reserves 2,500 of it, so the order becomes oversized.
    const quotable = await ctx.vault.quotableCorridor()
    expect(quotable).to.equal(cngn(17_500n))
    const { hash, signature, params, outputAmount } = await signCorridorSell(
      ctx,
      vaultAddr,
      probeAddr,
      quotable
    )
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_MAGIC)

    await settleWithFreshAttestation(ctx, epochB, 'redeem')
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_FAIL)

    await ctx.settlement.mint(probeAddr, outputAmount)
    await probe.approveToken(await ctx.settlement.getAddress(), ctx.reactor)
    await probe.arm(encodeLimitOrder(params), signature, hash)
    await probe.claim(epochB)

    expect(await probe.entered()).to.equal(true)
    expect(await probe.seenMagic()).to.equal(ERC1271_FAIL)
    expect(await probe.filled()).to.equal(false)

    // The probe got its own 2,500; lp1's 2,500 is still reserved and backed.
    expect(await ctx.corridor.balanceOf(probeAddr)).to.equal(cngn(2_500n))
    expect(await ctx.vault.reservedCorridor()).to.equal(cngn(2_500n))
    expect(await ctx.corridor.balanceOf(vaultAddr)).to.equal(cngn(17_500n))
    expect(await ctx.vault.freeCorridor()).to.equal(cngn(15_000n))

    const before = await ctx.corridor.balanceOf(ctx.lp1.address)
    await ctx.vault.connect(ctx.lp1).claim(epochA, ctx.lp1.address, ctx.lp1.address)
    expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - before).to.equal(cngn(2_500n))
  })

  it('keeps inventory views honest inside the payout callback', async function () {
    const ctx = await deployCallbackVault()
    const { vaultAddr, probe, epochB } = await stageTwoRedeemers(ctx)
    const probeAddr = await probe.getAddress()

    await settleWithFreshAttestation(ctx, epochB, 'redeem')
    // A correctly sized order: valid outside any callback.
    const { hash, signature, params, outputAmount } = await signCorridorSell(
      ctx,
      vaultAddr,
      probeAddr,
      cngn(1_000n)
    )
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_MAGIC)

    await ctx.settlement.mint(probeAddr, outputAmount)
    await probe.approveToken(await ctx.settlement.getAddress(), ctx.reactor)
    await probe.arm(encodeLimitOrder(params), signature, hash)
    await probe.claim(epochB)

    // Both epochs' corridor is still reserved while the settlement leg pays out,
    // so the views match what they read outside the claim.
    expect(await probe.seenReserved()).to.equal(cngn(5_000n))
    expect(await probe.seenFree()).to.equal(cngn(15_000n))
    expect(await probe.seenQuotable()).to.equal(cngn(15_000n))
    // Even a correctly sized order isn't authorised from inside a guarded call.
    expect(await probe.seenMagic()).to.equal(ERC1271_FAIL)
    expect(await probe.filled()).to.equal(false)
    // And it still fills normally once the claim has returned.
    expect(await ctx.vault.isValidSignature(hash, signature)).to.equal(ERC1271_MAGIC)
  })
})
