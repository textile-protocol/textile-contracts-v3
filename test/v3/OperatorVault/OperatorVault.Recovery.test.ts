import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { ERC1271_FAIL, PRICE_1, deployOperatorVault, usdt } from './fixtures/operatorVault.fixture'
import { closeAndSettleRedeem, closeRedeem, seedShares } from './helpers/vaultLifecycle'
import { freshAttestation, signAttestation } from './helpers/vaultSignatures'

describe('OperatorVault — recovery', function () {
  describe('sweepToken', function () {
    it('lets the guardian sweep a junk token', async function () {
      const ctx = await deployOperatorVault()
      const Junk = await ethers.getContractFactory('ERC20Mock')
      const junk = await Junk.deploy('Junk', 'JNK', 18)
      const vaultAddr = await ctx.vault.getAddress()
      const junkAddr = await junk.getAddress()
      await junk.mint(vaultAddr, 5n * 10n ** 18n)
      await expect(ctx.vault.connect(ctx.guardian).sweepToken(junkAddr, ctx.other.address))
        .to.emit(ctx.vault, 'TokenSwept')
        .withArgs(junkAddr, ctx.other.address, 5n * 10n ** 18n)
      expect(await junk.balanceOf(ctx.other.address)).to.equal(5n * 10n ** 18n)
      expect(await junk.balanceOf(vaultAddr)).to.equal(0)
    })

    it('rejects the settlement and corridor assets', async function () {
      const ctx = await deployOperatorVault()
      await expect(
        ctx.vault.connect(ctx.guardian).sweepToken(await ctx.settlement.getAddress(), ctx.other.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
      await expect(
        ctx.vault.connect(ctx.guardian).sweepToken(await ctx.corridor.getAddress(), ctx.other.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
    })

    it('rejects the vault share token', async function () {
      const ctx = await deployOperatorVault()
      await seedShares(ctx, ctx.lp1)
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(400n), ctx.lp1.address, ctx.lp1.address)
      await expect(
        ctx.vault.connect(ctx.guardian).sweepToken(await ctx.vault.getAddress(), ctx.other.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
    })

    it('rejects a stranger, a zero receiver, and an empty balance', async function () {
      const ctx = await deployOperatorVault()
      const Junk = await ethers.getContractFactory('ERC20Mock')
      const junk = await Junk.deploy('Junk', 'JNK', 18)
      const junkAddr = await junk.getAddress()
      await expect(
        ctx.vault.connect(ctx.lp1).sweepToken(junkAddr, ctx.other.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'NotAuthorized')
      await expect(
        ctx.vault.connect(ctx.operatorAdmin).sweepToken(junkAddr, ctx.other.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'NotAuthorized')
      await expect(
        ctx.vault.connect(ctx.guardian).sweepToken(junkAddr, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.vault, 'ZeroAddress')
      await expect(
        ctx.vault.connect(ctx.guardian).sweepToken(junkAddr, ctx.other.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'ZeroAmount')
    })
  })

  describe('sweepETH', function () {
    it('lets the guardian sweep forced ETH', async function () {
      const ctx = await deployOperatorVault()
      const vaultAddr = await ctx.vault.getAddress()
      await ethers.provider.send('hardhat_setBalance', [vaultAddr, '0xde0b6b3a7640000'])
      const before = await ethers.provider.getBalance(ctx.other.address)
      await expect(ctx.vault.connect(ctx.guardian).sweepETH(ctx.other.address))
        .to.emit(ctx.vault, 'ETHSwept')
        .withArgs(ctx.other.address, 10n ** 18n)
      expect(await ethers.provider.getBalance(vaultAddr)).to.equal(0)
      expect(await ethers.provider.getBalance(ctx.other.address)).to.equal(before + 10n ** 18n)
    })

    it('rejects a stranger, a zero or self receiver, and an empty balance', async function () {
      const ctx = await deployOperatorVault()
      await expect(ctx.vault.connect(ctx.lp1).sweepETH(ctx.other.address)).to.be.revertedWithCustomError(
        ctx.vault,
        'NotAuthorized'
      )
      await expect(
        ctx.vault.connect(ctx.guardian).sweepETH(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(ctx.vault, 'ZeroAddress')
      await expect(
        ctx.vault.connect(ctx.guardian).sweepETH(await ctx.vault.getAddress())
      ).to.be.revertedWithCustomError(ctx.vault, 'InvalidParams')
      await expect(ctx.vault.connect(ctx.guardian).sweepETH(ctx.other.address)).to.be.revertedWithCustomError(
        ctx.vault,
        'ZeroAmount'
      )
    })
  })

  describe('settleRedeemEmergencyInKind', function () {
    it('pays live inventory, including surplus, after pause and the emergency timeout', async function () {
      const ctx = await deployOperatorVault()
      await seedShares(ctx, ctx.lp1)
      const surplus = 10n ** 18n
      await ctx.corridor.mint(await ctx.vault.getAddress(), surplus)
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
      const epochId = await closeRedeem(ctx)
      await ctx.vault.connect(ctx.guardian).pause()
      const inKind = await ctx.vault.inKindExitTimeout()
      const emergency = await ctx.vault.emergencyExitTimeout()
      await expect(ctx.vault.settleRedeemEmergencyInKind(epochId)).to.be.revertedWithCustomError(
        ctx.vault,
        'TimeoutNotReached'
      )
      await time.increase(inKind)
      await expect(ctx.vault.settleRedeemEmergencyInKind(epochId)).to.be.revertedWithCustomError(
        ctx.vault,
        'TimeoutNotReached'
      )
      await time.increase(emergency - inKind)
      await expect(ctx.vault.connect(ctx.lp2).settleRedeemEmergencyInKind(epochId))
        .to.emit(ctx.vault, 'RedeemEpochSettled')
        .withArgs(epochId, true, usdt(1_000n), usdt(1_000n), surplus)
      expect(await ctx.vault.closeOnly()).to.equal(false)
      expect(await ctx.vault.isValidSignature(ethers.ZeroHash, '0x')).to.equal(ERC1271_FAIL)

      const beforeS = await ctx.settlement.balanceOf(ctx.lp1.address)
      const beforeC = await ctx.corridor.balanceOf(ctx.lp1.address)
      await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
      expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - beforeS).to.equal(usdt(1_000n))
      expect((await ctx.corridor.balanceOf(ctx.lp1.address)) - beforeC).to.equal(surplus)
      expect(await ctx.vault.totalSupply()).to.equal(0)
      expect(await ctx.vault.lastSettledNav()).to.equal(0)
      expect(await ctx.vault.reservedSettlement()).to.equal(0)
      expect(await ctx.vault.reservedCorridor()).to.equal(0)
    })

    it('does not let a hostile risk attestation settle a paused partial epoch at zero', async function () {
      const ctx = await deployOperatorVault()
      await seedShares(ctx, ctx.lp1, usdt(1_000n))
      await ctx.vault.connect(ctx.lp1).transfer(ctx.lp2.address, usdt(200n))
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(800n), ctx.lp1.address, ctx.lp1.address)
      const epochId = await closeRedeem(ctx)
      await ctx.vault.connect(ctx.guardian).pause()
      await time.increase(await ctx.vault.inKindExitTimeout())

      const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
      att.freeSettlement = 0n
      att.freeCorridor = 0n
      att.nav = 0n
      const sig = await signAttestation(ctx.harness, ctx.risk, att)
      await ctx.vault.settleRedeemInKind(epochId, att, sig)

      const before = await ctx.settlement.balanceOf(ctx.lp1.address)
      await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
      expect((await ctx.settlement.balanceOf(ctx.lp1.address)) - before).to.equal(usdt(800n))
      await expect(ctx.vault.settleRedeemEmergencyInKind(epochId)).to.be.revertedWithCustomError(
        ctx.vault,
        'EpochNotClosed'
      )
    })

    it('refuses to run unless the vault is paused', async function () {
      const ctx = await deployOperatorVault()
      await seedShares(ctx, ctx.lp1)
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(400n), ctx.lp1.address, ctx.lp1.address)
      const epochId = await closeRedeem(ctx)
      await time.increase(await ctx.vault.emergencyExitTimeout())
      await expect(ctx.vault.settleRedeemEmergencyInKind(epochId)).to.be.revertedWithCustomError(
        ctx.vault,
        'PauseRequired'
      )
    })

    it('rejects a deposit epoch, an open redeem, and a settled epoch', async function () {
      const ctx = await deployOperatorVault()
      await ctx.vault.connect(ctx.lp1).requestDeposit(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
      const depositId = await ctx.vault.currentDepositEpochId()
      await ctx.vault.connect(ctx.guardian).pause()
      await time.increase(await ctx.vault.emergencyExitTimeout())
      await expect(ctx.vault.settleRedeemEmergencyInKind(depositId)).to.be.revertedWithCustomError(
        ctx.vault,
        'EpochNotClosed'
      )

      const open = await deployOperatorVault()
      await seedShares(open, open.lp1)
      await open.vault.connect(open.lp1).requestRedeem(usdt(200n), open.lp1.address, open.lp1.address)
      const openId = await open.vault.currentRedeemEpochId()
      await open.vault.connect(open.guardian).pause()
      await time.increase(await open.vault.emergencyExitTimeout())
      await expect(open.vault.settleRedeemEmergencyInKind(openId)).to.be.revertedWithCustomError(
        open.vault,
        'EpochNotClosed'
      )

      const settled = await deployOperatorVault()
      await seedShares(settled, settled.lp1)
      await settled.vault.connect(settled.lp1).requestRedeem(usdt(200n), settled.lp1.address, settled.lp1.address)
      const settledId = await closeAndSettleRedeem(settled)
      await settled.vault.connect(settled.guardian).pause()
      await time.increase(await settled.vault.emergencyExitTimeout())
      await expect(settled.vault.settleRedeemEmergencyInKind(settledId)).to.be.revertedWithCustomError(
        settled.vault,
        'EpochNotClosed'
      )
    })

    it('splits two LPs from live balances and gives the last claimer the residue', async function () {
      const ctx = await deployOperatorVault()
      await seedShares(ctx, ctx.lp1, usdt(1_000n))
      await ctx.vault.connect(ctx.lp1).transfer(ctx.lp2.address, usdt(333n))
      const surplus = 1_000n
      await ctx.corridor.mint(await ctx.vault.getAddress(), surplus)
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(333n), ctx.lp1.address, ctx.lp1.address)
      await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(333n), ctx.lp2.address, ctx.lp2.address)
      const epochId = await closeRedeem(ctx)
      await ctx.vault.connect(ctx.guardian).pause()
      await time.increase(await ctx.vault.emergencyExitTimeout())
      await ctx.vault.settleRedeemEmergencyInKind(epochId)

      const before1 = await ctx.corridor.balanceOf(ctx.lp1.address)
      const before2 = await ctx.corridor.balanceOf(ctx.lp2.address)
      await ctx.vault.connect(ctx.lp1).claim(epochId, ctx.lp1.address, ctx.lp1.address)
      await ctx.vault.connect(ctx.lp2).claim(epochId, ctx.lp2.address, ctx.lp2.address)
      const got1 = (await ctx.corridor.balanceOf(ctx.lp1.address)) - before1
      const got2 = (await ctx.corridor.balanceOf(ctx.lp2.address)) - before2
      expect(got1 + got2).to.equal((surplus * usdt(666n)) / usdt(1_000n))
      expect(await ctx.vault.reservedCorridor()).to.equal(0)
    })
  })
})
