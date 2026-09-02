import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import {
  DAY,
  ERC1271_FAIL,
  ERC1271_MAGIC,
  PRICE_1,
  RAY,
  accrueAaveInterest,
  defaultInit,
  deployOperatorVault,
  usdt,
  cngn,
  type DeployedVault,
} from './fixtures/operatorVault.fixture'
import { closeRedeem, seedShares } from './helpers/vaultLifecycle'
import { freshAttestation, signAttestation, signVaultEnvelope } from './helpers/vaultSignatures'

async function liquidOf(ctx: DeployedVault): Promise<bigint> {
  const [balance, pending, reserved] = await Promise.all([
    ctx.settlement.balanceOf(await ctx.vault.getAddress()),
    ctx.vault.pendingSettlement(),
    ctx.vault.reservedSettlement(),
  ])
  return balance - pending - reserved
}

describe('OperatorVault — idle yield', function () {
  describe('without an adapter', function () {
    it('keeps the yield entrypoints as safe no-ops', async function () {
      const ctx = await deployOperatorVault()
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      expect(await ctx.vault.yieldAdapter()).to.equal(ethers.ZeroAddress)
      expect(await ctx.vault.freeSettlement()).to.equal(usdt(10_000n))
      expect(await ctx.vault.quotableSettlement()).to.equal(usdt(10_000n))

      await ctx.vault.allocateIdle()
      await ctx.vault.recallAll()
      expect(await ctx.settlement.balanceOf(await ctx.vault.getAddress())).to.equal(usdt(10_000n))

      // Covered by liquid → no-op; beyond liquid → nothing to recall from.
      await ctx.vault.prepareSettlement(usdt(10_000n))
      await expect(ctx.vault.prepareSettlement(usdt(10_001n))).to.be.revertedWithCustomError(
        ctx.vault,
        'InsufficientSettlement'
      )
    })
  })

  describe('constructor and factory wiring', function () {
    it('binds and approves a cloned adapter at deploy time', async function () {
      const ctx = await deployOperatorVault({ enableYield: true, minLiquidSettlement: usdt(1_000n) })
      const vaultAddr = await ctx.vault.getAddress()
      const adapterAddr = await ctx.vault.yieldAdapter()
      expect(adapterAddr).to.not.equal(ethers.ZeroAddress)
      expect(adapterAddr).to.not.equal(await ctx.adapterImpl.getAddress())
      expect(await ctx.adapter.vault()).to.equal(vaultAddr)
      expect(await ctx.adapter.asset()).to.equal(await ctx.settlement.getAddress())
      expect(await ctx.adapter.aToken()).to.equal(await ctx.aToken.getAddress())
      expect(await ctx.vault.minLiquidSettlement()).to.equal(usdt(1_000n))
      expect(await ctx.settlement.allowance(vaultAddr, adapterAddr)).to.equal(ethers.MaxUint256)
      // Corridor is never approved to the adapter.
      expect(await ctx.corridor.allowance(vaultAddr, adapterAddr)).to.equal(0n)

      await expect(
        ctx.adapter.initialize(vaultAddr, await ctx.settlement.getAddress())
      ).to.be.revertedWithCustomError(ctx.adapter, 'AlreadyInitialized')
    })

    it('refuses enableYield when the factory has no implementation', async function () {
      const ctx = await deployOperatorVault()
      const Factory = await ethers.getContractFactory('OperatorVaultFactory', {
        libraries: { VaultDeployer: ctx.vaultDeployer },
      })
      const bare = await Factory.deploy(ctx.reactor, ctx.permit2, ctx.preferredFiller, ethers.ZeroAddress)
      const init = defaultInit(ctx, { enableYield: true })
      init.settlementAsset = await ctx.settlement.getAddress()
      init.corridorAsset = await ctx.corridor.getAddress()
      await expect(bare.connect(ctx.operatorAdmin).deployVault(init)).to.be.revertedWithCustomError(
        bare,
        'YieldNotSupported'
      )
    })

    it('rejects a liquid floor without yield enabled', async function () {
      const ctx = await deployOperatorVault()
      const init = defaultInit(ctx, { minLiquidSettlement: usdt(1n) })
      init.settlementAsset = await ctx.settlement.getAddress()
      init.corridorAsset = await ctx.corridor.getAddress()
      init.operatorAdmin = ctx.other.address
      await expect(ctx.factory.connect(ctx.other).deployVault(init)).to.be.reverted
    })
  })

  describe('allocateIdle', function () {
    it('supplies only idle settlement above the floor, never pending or reserved', async function () {
      const ctx = await deployOperatorVault({ enableYield: true, minLiquidSettlement: usdt(1_000n) })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))

      await expect(ctx.vault.connect(ctx.other).allocateIdle())
        .to.emit(ctx.vault, 'IdleAllocated')
        .withArgs(usdt(9_000n))
      expect(await ctx.adapter.held()).to.equal(usdt(9_000n))
      expect(await liquidOf(ctx)).to.equal(usdt(1_000n))

      // Pending deposits never supply.
      await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(5_000n), ctx.lp2.address, ctx.lp2.address)
      await ctx.vault.allocateIdle()
      expect(await ctx.adapter.held()).to.equal(usdt(9_000n))

      // Reserved payouts never supply either.
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(2_000n), ctx.lp1.address, ctx.lp1.address)
      const redeemId = await closeRedeem(ctx)
      const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await ctx.vault.settleRedeemEpoch(redeemId, att, sig)
      expect(await ctx.vault.reservedSettlement()).to.equal(usdt(2_000n))

      await ctx.vault.allocateIdle()
      expect(await ctx.adapter.held()).to.equal(usdt(7_000n))
      expect(await liquidOf(ctx)).to.equal(usdt(1_000n))
      // Pending + reserved + floor stay liquid in the vault.
      expect(await ctx.settlement.balanceOf(await ctx.vault.getAddress())).to.equal(usdt(8_000n))
    })

    it('no-ops at or below the floor, when paused, and in close-only', async function () {
      const ctx = await deployOperatorVault({ enableYield: true, minLiquidSettlement: usdt(1_000n) })
      await seedShares(ctx, ctx.lp1, usdt(1_000n))
      await ctx.vault.allocateIdle()
      expect(await ctx.adapter.held()).to.equal(0n)

      await seedShares(ctx, ctx.lp2, usdt(4_000n))
      await ctx.vault.connect(ctx.guardian).pause()
      await ctx.vault.allocateIdle()
      expect(await ctx.adapter.held()).to.equal(0n)
      await ctx.vault.connect(ctx.guardian).unpause()

      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(500n), ctx.lp1.address, ctx.lp1.address)
      await closeRedeem(ctx)
      expect(await ctx.vault.closeOnly()).to.equal(true)
      await ctx.vault.allocateIdle()
      expect(await ctx.adapter.held()).to.equal(0n)
    })
  })

  describe('economic inventory', function () {
    it('includes held and accrued interest in free, quotable, and NAV', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()
      expect(await liquidOf(ctx)).to.equal(0n)
      expect(await ctx.vault.freeSettlement()).to.equal(usdt(10_000n))
      expect(await ctx.vault.quotableSettlement()).to.equal(usdt(10_000n))

      await accrueAaveInterest(ctx, (RAY * 11n) / 10n)
      expect(await ctx.vault.freeSettlement()).to.equal(usdt(11_000n))
      expect(await ctx.vault.quotableSettlement()).to.equal(usdt(11_000n))

      // A deposit epoch converts at the economic NAV and records it.
      const { depositId } = await seedShares(ctx, ctx.lp2, usdt(1_000n))
      expect(depositId).to.not.equal(0n)
      expect(await ctx.vault.lastSettledNav()).to.equal(await ctx.vault.freeSettlement())
      expect(await ctx.vault.lastSettledNav()).to.equal(usdt(12_000n))
    })

    it('respects the minReserve floor on top of economic inventory', async function () {
      const ctx = await deployOperatorVault({
        enableYield: true,
        minReserveSettlement: usdt(2_000n),
      })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()
      expect(await ctx.vault.quotableSettlement()).to.equal(usdt(8_000n))
    })

    it('caps ERC-1271 settlement orders at liquid; held counts only after prepare', async function () {
      const ctx = await deployOperatorVault({ enableYield: true, minLiquidSettlement: usdt(1_000n) })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()
      expect(await liquidOf(ctx)).to.equal(usdt(1_000n))
      // Pending deposits push raw balanceOf to 6k but must never fund a fill.
      await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(5_000n), ctx.lp2.address, ctx.lp2.address)

      const chainId = Number((await ethers.provider.getNetwork()).chainId)
      const now = (await ethers.provider.getBlock('latest'))!.timestamp
      const epoch = await ctx.vault.tradingEpoch()
      const baseOrder = (inputAmount: bigint, counter: bigint) => ({
        reactor: ctx.reactor,
        vault: ctx.vault.target as string,
        permit2: ctx.permit2,
        chainId,
        nonce: (epoch << 128n) | counter,
        deadline: BigInt(now + 600),
        inputToken: ctx.settlement.target as string,
        inputAmount,
        outputToken: ctx.corridor.target as string,
        outputAmount: cngn(100n),
        preferredFiller: ctx.preferredFiller,
        taker: ctx.other.address,
      })

      expect(await ctx.vault.liquidSettlement()).to.equal(usdt(1_000n))
      expect(await ctx.vault.quotableSettlement()).to.equal(usdt(10_000n))

      // liquid (1k) < input (4k) <= balanceOf (6k) <= economic (10k): a pull
      // would eat pending deposits, so the envelope must be rejected.
      const beyondLiquid = await signVaultEnvelope(ctx.strategy, ctx.risk, baseOrder(usdt(4_000n), 1n))
      expect(await ctx.vault.isValidSignature(beyondLiquid.hash, beyondLiquid.signature)).to.equal(
        ERC1271_FAIL
      )

      // The same envelope validates once the gap is recalled from Aave.
      await ctx.vault.prepareSettlement(usdt(4_000n))
      expect(await ctx.vault.liquidSettlement()).to.equal(usdt(4_000n))
      expect(await ctx.vault.isValidSignature(beyondLiquid.hash, beyondLiquid.signature)).to.equal(
        ERC1271_MAGIC
      )

      // Quoting still prices economic inventory throughout.
      expect(await ctx.vault.quotableSettlement()).to.equal(usdt(10_000n))

      // Above economic quotable stays rejected regardless of liquidity.
      const beyondEconomic = await signVaultEnvelope(
        ctx.strategy,
        ctx.risk,
        baseOrder(usdt(10_001n), 2n)
      )
      expect(await ctx.vault.isValidSignature(beyondEconomic.hash, beyondEconomic.signature)).to.equal(
        ERC1271_FAIL
      )
    })
  })

  describe('prepareSettlement', function () {
    it('recalls exactly the gap and no-ops when liquid already covers', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()

      await expect(ctx.vault.connect(ctx.other).prepareSettlement(usdt(4_000n)))
        .to.emit(ctx.vault, 'SettlementPrepared')
        .withArgs(usdt(4_000n), usdt(4_000n))
      expect(await liquidOf(ctx)).to.equal(usdt(4_000n))
      expect(await ctx.adapter.held()).to.equal(usdt(6_000n))

      await expect(ctx.vault.prepareSettlement(usdt(3_000n))).to.not.emit(
        ctx.vault,
        'SettlementPrepared'
      )
      expect(await liquidOf(ctx)).to.equal(usdt(4_000n))
    })

    it('is strict about a 1-wei recall shortfall', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()
      await ctx.aavePool.setWithdrawShaveWei(1n)
      await expect(ctx.vault.prepareSettlement(usdt(4_000n))).to.be.revertedWithCustomError(
        ctx.vault,
        'InsufficientSettlement'
      )
    })

    it('reverts when the request exceeds economic inventory', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()
      await expect(ctx.vault.prepareSettlement(usdt(10_001n))).to.be.reverted
    })
  })

  describe('recall on redeem settlement', function () {
    it('recalls the full position before a cash settle', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(2_000n), ctx.lp1.address, ctx.lp1.address)
      const redeemId = await closeRedeem(ctx)
      const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)

      await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig))
        .to.emit(ctx.vault, 'IdleRecalled')
        .withArgs(usdt(10_000n))
      expect(await ctx.adapter.held()).to.equal(0n)
      expect(await ctx.vault.reservedSettlement()).to.equal(usdt(2_000n))

      await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
      expect(await ctx.vault.reservedSettlement()).to.equal(0n)
    })

    it('recalls before an attested in-kind settle', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(1_000n))
      await ctx.vault.connect(ctx.lp1).transfer(ctx.lp2.address, usdt(200n))
      await ctx.vault.allocateIdle()
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(800n), ctx.lp1.address, ctx.lp1.address)
      const redeemId = await closeRedeem(ctx)
      await time.increase(await ctx.vault.inKindExitTimeout())

      const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await expect(ctx.vault.settleRedeemInKind(redeemId, att, sig)).to.emit(ctx.vault, 'IdleRecalled')
      expect(await ctx.adapter.held()).to.equal(0n)
    })

    it('fails cash settlement while Aave is down, but the emergency exit still pays out', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(2_000n), ctx.lp1.address, ctx.lp1.address)
      const redeemId = await closeRedeem(ctx)

      await ctx.aavePool.setWithdrawReverts(true)
      const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await expect(ctx.vault.settleRedeemEpoch(redeemId, att, sig)).to.be.reverted

      // Guardian pause never touches Aave.
      await expect(ctx.vault.connect(ctx.guardian).pause()).to.emit(ctx.vault, 'Paused')

      // The emergency exit does not wait for Aave: the stranded position is
      // settled pro-rata in aTokens (H-01 remediation).
      await time.increase(await ctx.vault.emergencyExitTimeout())
      await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId))
        .to.emit(ctx.vault, 'RedeemYieldSettled')
        .withArgs(redeemId, usdt(2_000n))
      expect(await ctx.adapter.held()).to.equal(usdt(8_000n))
    })
  })

  describe('adapter access control from the vault side', function () {
    it('rejects deploy/recall from anyone but the vault', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(1_000n))
      await ctx.vault.allocateIdle()
      await expect(ctx.adapter.connect(ctx.operatorAdmin).deploy(usdt(1n))).to.be.revertedWithCustomError(
        ctx.adapter,
        'NotAuthorized'
      )
      await expect(ctx.adapter.connect(ctx.guardian).recall(usdt(1n))).to.be.revertedWithCustomError(
        ctx.adapter,
        'NotAuthorized'
      )
    })

    it('keeps guardian sweep off the working assets while yield is on', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await expect(
        ctx.vault.connect(ctx.guardian).sweepToken(await ctx.settlement.getAddress(), ctx.other.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
    })
  })

  describe('interest with a pending epoch', function () {
    it('keeps attestation floors satisfiable as interest accrues mid-epoch', async function () {
      const ctx = await deployOperatorVault({ enableYield: true })
      await seedShares(ctx, ctx.lp1, usdt(10_000n))
      await ctx.vault.allocateIdle()

      await ctx.vault.connect(ctx.lp2).requestDeposit(usdt(1_000n), ctx.lp2.address, ctx.lp2.address)
      const depositId = await ctx.vault.currentDepositEpochId()
      await time.increase(DAY)
      await ctx.vault.closeDepositEpoch(depositId)

      // Attestation snapshot, then more interest lands before processing.
      const att = await freshAttestation(ctx.vault, depositId, PRICE_1)
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await accrueAaveInterest(ctx, (RAY * 101n) / 100n)

      await expect(ctx.vault.processDepositEpoch(depositId, att, sig)).to.emit(
        ctx.vault,
        'DepositEpochProcessed'
      )
      // Surplus interest is marked into the settled NAV afterwards.
      expect(await ctx.vault.lastSettledNav()).to.equal(await ctx.vault.freeSettlement())
    })
  })
})
