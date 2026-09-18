import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import * as math from '../../../constants/src/operatorVaultMath'

import {
  DAY,
  PRICE_1,
  PROTOCOL_FEE_SHARE_WAD,
  WAD,
  defaultInit,
  deployOperatorVault,
  cngn,
  usdt,
} from './fixtures/operatorVault.fixture'
import type { DeployedVault } from './fixtures/operatorVault.fixture'
import { closeAndProcessDeposit, closeAndSettleRedeem, closeRedeem, seedShares } from './helpers/vaultLifecycle'
import { freshAttestation, attestationSignatures } from './helpers/vaultSignatures'

describe('OperatorVault — management fee', function () {
  it('checkpoints the fee before a paused full-supply settle', async function () {
    const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
    await seedShares(ctx, ctx.lp1)

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, redeemId)
    await ctx.vault.connect(ctx.guardian).pause()
    await time.increase(365 * DAY)
    const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
    const sigs = await attestationSignatures(ctx, att)
    await ctx.vault.settleRedeemEpoch(redeemId, att, ...sigs)

    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.be.gt(0)
  })

  it('checkpoints accrued fees to the old recipient before a change', async function () {
    const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
    await seedShares(ctx, ctx.lp1)
    await time.increase(365 * DAY)
    await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.be.gt(0)
    expect(await ctx.vault.balanceOf(ctx.other.address)).to.equal(0)
  })

  it('does not mint fee shares when the rate is zero', async function () {
    const ctx = await deployOperatorVault()
    await seedShares(ctx, ctx.lp1)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(0)
    expect(await ctx.vault.balanceOf(ctx.protocolFeeRecipient.address)).to.equal(0)
  })

  describe('protocol cut', function () {
    /** Accrue one year at the vault's rate and return what each recipient
     *  was minted plus what the single-recipient formula says the whole
     *  accrual was. */
    async function accrueOneYear(ctx: DeployedVault) {
      await seedShares(ctx, ctx.lp1)
      const supply = await ctx.vault.totalSupply()
      const t0 = await ctx.vault.lastFeeCheckpoint()
      await time.increase(365 * DAY)
      // Any checkpoint will do; the recipient change is the cheapest to reach
      // and moves nothing the split cares about.
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)
      const t1 = await ctx.vault.lastFeeCheckpoint()
      const whole = math.feeShares(supply, await ctx.vault.managementFeeWad(), t1 - t0)
      return {
        supply,
        whole,
        operator: await ctx.vault.balanceOf(ctx.feeRecipient.address),
        protocol: await ctx.vault.balanceOf(ctx.protocolFeeRecipient.address),
      }
    }

    it('gives the protocol a tenth and the operator the rest of one accrual', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      const { supply, whole, operator, protocol } = await accrueOneYear(ctx)

      expect(whole).to.be.gt(0)
      expect(operator + protocol).to.equal(whole)
      expect(protocol).to.equal(math.splitFee(whole, PROTOCOL_FEE_SHARE_WAD).protocolShares)
      // A tenth of the fee, not a tenth on top: the LPs are diluted by
      // exactly the old amount.
      expect((await ctx.vault.totalSupply()) - supply).to.equal(whole)
    })

    it('emits one FeeAccrued per recipient', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      await seedShares(ctx, ctx.lp1)
      await time.increase(365 * DAY)
      const tx = ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)
      const positive = (n: bigint) => n > 0n
      await expect(tx)
        .to.emit(ctx.vault, 'FeeAccrued')
        .withArgs(ctx.feeRecipient.address, positive, positive)
      await expect(tx)
        .to.emit(ctx.vault, 'FeeAccrued')
        .withArgs(ctx.protocolFeeRecipient.address, positive, positive)
    })

    it('takes nothing from a vault deployed with a zero cut', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n, protocolManagementShareWad: 0n, protocolPerformanceShareWad: 0n })
      const { whole, operator, protocol } = await accrueOneYear(ctx)
      expect(operator).to.equal(whole)
      expect(protocol).to.equal(0)
    })

    it('follows the operator recipient change without touching its own leg', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      const first = await accrueOneYear(ctx)
      // The recipient is `other` now. Accrue another year.
      await time.increase(365 * DAY)
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.feeRecipient.address)
      const toOther = await ctx.vault.balanceOf(ctx.other.address)
      const protocolNow = await ctx.vault.balanceOf(ctx.protocolFeeRecipient.address)
      const secondWhole = toOther + (protocolNow - first.protocol)

      expect(toOther).to.be.gt(0)
      expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(first.operator)
      expect(protocolNow - first.protocol).to.equal(
        math.splitFee(secondWhole, PROTOCOL_FEE_SHARE_WAD).protocolShares
      )
    })

    it('mints both legs to one address when the operator names the protocol wallet', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.protocolFeeRecipient.address)
      await seedShares(ctx, ctx.lp1)
      const supply = await ctx.vault.totalSupply()
      await time.increase(365 * DAY)
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)
      const minted = (await ctx.vault.totalSupply()) - supply
      expect(minted).to.be.gt(0)
      expect(await ctx.vault.balanceOf(ctx.protocolFeeRecipient.address)).to.equal(minted)
    })
  })

  it('splits each leg on its own terms', async function () {
    // 10% of the management fee, 25% of the performance fee, set at deploy.
    const ctx = await deployOperatorVault({
      managementFeeWad: WAD / 50n,
      performanceFeeWad: WAD / 5n,
      protocolManagementShareWad: WAD / 10n,
      protocolPerformanceShareWad: WAD / 4n,
      minRedeemShares: usdt(1n),
    })
    await seedShares(ctx, ctx.lp1, usdt(1_000_000n))
    const supply = await ctx.vault.totalSupply()
    await ctx.settlement.mint(await ctx.vault.getAddress(), usdt(100_000n))
    const navAssets = await ctx.vault.freeSettlement()
    const before = await ctx.vault.lastFeeCheckpoint()
    await time.increase(365 * DAY)
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1n), ctx.lp1.address, ctx.lp1.address)
    await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId())

    const elapsed = (await ctx.vault.lastFeeCheckpoint()) - before
    const mgmt = math.feeShares(supply, WAD / 50n, elapsed)
    const perf = math.performanceFeeShares(navAssets, supply + mgmt, WAD, WAD / 5n)
    const expected =
      math.splitFee(mgmt, WAD / 10n).protocolShares + math.splitFee(perf, WAD / 4n).protocolShares
    expect(expected).to.be.gt(0)
    expect(await ctx.vault.balanceOf(ctx.protocolFeeRecipient.address)).to.equal(expected)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(mgmt + perf - expected)
  })

  describe('the protocol recipient can always exit its own dilution', function () {
    it('redeems under the floor, exactly like the operator recipient', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 100n })
      await seedShares(ctx, ctx.lp1)
      const lpShares = await ctx.vault.balanceOf(ctx.lp1.address)
      await ctx.vault.connect(ctx.lp1).requestRedeem(lpShares, ctx.lp1.address, ctx.lp1.address)
      const lpId = await ctx.vault.currentRedeemEpochId()
      await closeAndSettleRedeem(ctx, lpId)
      await ctx.vault.connect(ctx.lp1).claim(lpId, ctx.lp1.address, ctx.lp1.address)

      const proto = ctx.protocolFeeRecipient
      const held = await ctx.vault.balanceOf(proto.address)
      expect(held).to.be.gt(0)
      expect(held).to.be.lt(await ctx.vault.minRedeemShares())

      // Below the floor, both residue holders may queue; an LP may not.
      await expect(ctx.vault.connect(proto).requestRedeem(held, proto.address, proto.address)).to.not
        .be.reverted
      const op = ctx.feeRecipient
      const opHeld = await ctx.vault.balanceOf(op.address)
      await expect(ctx.vault.connect(op).requestRedeem(opHeld, op.address, op.address)).to.not.be
        .reverted
      await seedShares(ctx, ctx.lp2)
      await expect(
        ctx.vault.connect(ctx.lp2).requestRedeem(usdt(1n), ctx.lp2.address, ctx.lp2.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })

    it('settles and claims as the last holder, with the default cut on', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 100n })
      await seedShares(ctx, ctx.lp1)
      await ctx.vault.connect(ctx.guardian).pause()

      // Everyone ahead of the protocol recipient leaves: the LP, then the
      // operator's recipient. Each settle mints a fresh tail to both recipients.
      for (const holder of [ctx.lp1, ctx.feeRecipient]) {
        const held = await ctx.vault.balanceOf(holder.address)
        await ctx.vault.connect(holder).requestRedeem(held, holder.address, holder.address)
        const id = await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId())
        await ctx.vault.connect(holder).claim(id, holder.address, holder.address)
      }

      const proto = ctx.protocolFeeRecipient
      const held = await ctx.vault.balanceOf(proto.address)
      expect(held).to.be.gt(0)
      const before = await ctx.settlement.balanceOf(proto.address)
      await ctx.vault.connect(proto).requestRedeem(held, proto.address, proto.address)
      const id = await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId())
      await ctx.vault.connect(proto).claim(id, proto.address, proto.address)

      expect(await ctx.settlement.balanceOf(proto.address)).to.be.gt(before)
      expect(await ctx.vault.balanceOf(proto.address)).to.be.lt(held)
    })

    it('still refuses zero from the protocol recipient', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 100n })
      const proto = ctx.protocolFeeRecipient
      await expect(
        ctx.vault.connect(proto).requestRedeem(0n, proto.address, proto.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })
  })

  // The wind-down the two BSC gen3 vaults hit: the last LP exits and the fee's
  // dilution is left owning the vault, under the floor, with no way out.
  describe('the fee recipient can always exit its own dilution', function () {
    /** Wind the vault down to nothing but the fee recipient's own dilution. */
    // A zero-cut factory: this block is about a lone residue holder owning
    // the whole supply. The split itself is covered under `protocol cut`.
    async function windDown(): Promise<DeployedVault> {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 100n, protocolManagementShareWad: 0n, protocolPerformanceShareWad: 0n })
      await seedShares(ctx, ctx.lp1)

      const lpShares = await ctx.vault.balanceOf(ctx.lp1.address)
      await ctx.vault.connect(ctx.lp1).requestRedeem(lpShares, ctx.lp1.address, ctx.lp1.address)
      const redeemId = await ctx.vault.currentRedeemEpochId()
      await closeAndSettleRedeem(ctx, redeemId)
      await ctx.vault.connect(ctx.lp1).claim(redeemId, ctx.lp1.address, ctx.lp1.address)
      return ctx
    }

    it('leaves the fee holding the whole supply, under the floor', async function () {
      const ctx = await windDown()
      const feeShares = await ctx.vault.balanceOf(ctx.feeRecipient.address)

      expect(feeShares).to.be.gt(0)
      expect(feeShares).to.equal(await ctx.vault.totalSupply())
      expect(feeShares).to.be.lt(await ctx.vault.minRedeemShares())
      expect(await ctx.vault.freeSettlement()).to.be.gt(0)
    })

    /** Request, settle, claim the fee recipient's whole balance. Returns what
     *  is still in the vault after. Assumes the vault is already paused. */
    async function exitFee(ctx: DeployedVault): Promise<bigint> {
      const fee = ctx.feeRecipient
      const held = await ctx.vault.balanceOf(fee.address)
      await ctx.vault.connect(fee).requestRedeem(held, fee.address, fee.address)
      const feeId = await ctx.vault.currentRedeemEpochId()
      await closeAndSettleRedeem(ctx, feeId)
      await ctx.vault.connect(fee).claim(feeId, fee.address, fee.address)
      return ctx.vault.freeSettlement()
    }

    // Exact only because the settle-time checkpoint rounds to zero at this
    // size, so the queued shares really are the whole supply. The totalSupply
    // assertion pins that premise — see the convergence test below for what
    // happens when the checkpoint does mint.
    it('is paid every asset behind it once the guardian pauses', async function () {
      const ctx = await windDown()
      const fee = ctx.feeRecipient
      const stranded = await ctx.vault.freeSettlement()
      const before = await ctx.settlement.balanceOf(fee.address)

      await ctx.vault.connect(ctx.guardian).pause()
      expect(await exitFee(ctx)).to.equal(0)

      expect((await ctx.settlement.balanceOf(fee.address)) - before).to.equal(stranded)
      expect(await ctx.vault.totalSupply()).to.equal(0)
    })

    /**
     * Big enough that the settle-time checkpoint mints, so the queued shares
     * are no longer the whole supply and the exit pays pro rata. What is left
     * is the fee earned during the exit epoch itself — a new below-floor tail,
     * redeemable on the same exemption. So the exit converges instead of
     * completing in one pass, and nothing ever locks.
     */
    it('converges when the exit epoch accrues a new tail', async function () {
      const ctx = await deployOperatorVault({
        managementFeeWad: WAD / 10n,
        minRedeemShares: usdt(200_000n),
        protocolManagementShareWad: 0n, protocolPerformanceShareWad: 0n,
      })
      await seedShares(ctx, ctx.lp1, usdt(1_000_000n))
      await time.increase(365 * DAY)

      const lpShares = await ctx.vault.balanceOf(ctx.lp1.address)
      await ctx.vault.connect(ctx.lp1).requestRedeem(lpShares, ctx.lp1.address, ctx.lp1.address)
      const lpId = await ctx.vault.currentRedeemEpochId()
      await closeAndSettleRedeem(ctx, lpId)
      await ctx.vault.connect(ctx.lp1).claim(lpId, ctx.lp1.address, ctx.lp1.address)

      const stranded = await ctx.vault.freeSettlement()
      expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.be.lt(
        await ctx.vault.minRedeemShares()
      )

      await ctx.vault.connect(ctx.guardian).pause()
      const afterFirst = await exitFee(ctx)
      const afterSecond = await exitFee(ctx)

      // One pass is not the end, but it is almost all of it.
      expect(afterFirst).to.be.gt(0)
      expect(afterFirst).to.be.lt(stranded / 1_000n)
      // And each further pass takes the same bite out of what is left.
      expect(afterSecond).to.be.lt(afterFirst / 100n)
    })

    // The settle-time checkpoint rounds to zero on a position this small, so
    // `shares == supply` holds. The floor is lifted; this guard is not.
    it('still needs the pause to take the last share', async function () {
      const ctx = await windDown()
      const fee = ctx.feeRecipient
      const feeShares = await ctx.vault.balanceOf(fee.address)

      await ctx.vault.connect(fee).requestRedeem(feeShares, fee.address, fee.address)
      const feeId = await ctx.vault.currentRedeemEpochId()
      await expect(closeAndSettleRedeem(ctx, feeId)).to.be.revertedWithCustomError(
        ctx.vault,
        'PauseRequired'
      )
    })

    it('still refuses zero, from the fee recipient like anyone else', async function () {
      const ctx = await windDown()
      const fee = ctx.feeRecipient
      await expect(
        ctx.vault.connect(fee).requestRedeem(0n, fee.address, fee.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })

    it('does not lift the floor for an ordinary LP', async function () {
      const ctx = await windDown()
      await seedShares(ctx, ctx.lp2)
      await expect(
        ctx.vault.connect(ctx.lp2).requestRedeem(usdt(1n), ctx.lp2.address, ctx.lp2.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })

    it('does not lift the floor for the old recipient after a change', async function () {
      const ctx = await windDown()
      const old = ctx.feeRecipient
      const held = await ctx.vault.balanceOf(old.address)
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)

      await expect(
        ctx.vault.connect(old).requestRedeem(held, old.address, old.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
    })
  })
})

describe('OperatorVault — performance fee', function () {
  const PERF = WAD / 5n // 20% of the gain above the mark
  const SEED = usdt(1_000_000n)

  /** A vault holding `SEED`, no management fee, mark sitting at par. */
  async function seeded(extras: Record<string, bigint> = {}): Promise<DeployedVault> {
    const ctx = await deployOperatorVault({
      performanceFeeWad: PERF,
      minRedeemShares: usdt(1n),
      ...extras,
    })
    await seedShares(ctx, ctx.lp1, SEED)
    return ctx
  }

  /** Hand the vault settlement it did not earn from a deposit. The vault reads
   *  its own balance for NAV, so this is a gain as far as the fee is concerned. */
  async function gain(ctx: DeployedVault, amount: bigint): Promise<void> {
    await ctx.settlement.mint(await ctx.vault.getAddress(), amount)
  }

  /** Run one priced checkpoint by settling a token-sized redeem. */
  async function checkpoint(ctx: DeployedVault, price: bigint = PRICE_1): Promise<void> {
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1n), ctx.lp1.address, ctx.lp1.address)
    await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId(), price)
  }

  it('starts the mark at par and charges nothing before a gain', async function () {
    const ctx = await seeded()
    await checkpoint(ctx)

    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(0)
    expect(await ctx.vault.highWaterMarkWad()).to.equal(WAD)
  })

  it('takes its cut of the gain above the mark, and leaves the rest to the LP', async function () {
    const ctx = await seeded()
    const supply = await ctx.vault.totalSupply()
    await gain(ctx, usdt(100_000n))
    const navAssets = await ctx.vault.freeSettlement()

    await checkpoint(ctx)

    // The performance leg is split with the protocol on the same terms as the
    // management leg, so the operator's recipient sees its share of the whole.
    const total = math.performanceFeeShares(navAssets, supply, WAD, PERF)
    const { operatorShares } = math.splitFee(total, PROTOCOL_FEE_SHARE_WAD)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(operatorShares)

    // The whole point of minting against post-fee NAV: the LP keeps exactly
    // 80% of the 100k gain, not 80%/(1+20%) of it. Dilution is the same total
    // either way — how the fee is split does not change what the LP bears.
    const lpValue = (SEED * navAssets) / (supply + total)
    expect(lpValue).to.be.closeTo(SEED + usdt(80_000n), usdt(1n))
  })

  it('emits the mark when it moves, and only then', async function () {
    const ctx = await seeded()
    await gain(ctx, usdt(100_000n))
    const settle = async () => {
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1n), ctx.lp1.address, ctx.lp1.address)
      const id = await closeRedeem(ctx, await ctx.vault.currentRedeemEpochId())
      const att = await freshAttestation(ctx.vault, id, PRICE_1)
      return ctx.vault.settleRedeemEpoch(id, att, ...(await attestationSignatures(ctx, att)))
    }
    await expect(settle()).to.emit(ctx.vault, 'HighWaterMarkUpdated')
    expect(await ctx.vault.highWaterMarkWad()).to.be.gt(WAD)
    await expect(settle()).to.not.emit(ctx.vault, 'HighWaterMarkUpdated')
  })

  it('charges surplus that landed after the attestation when a paused exit pays live balances', async function () {
    const ctx = await seeded()
    const supply = await ctx.vault.totalSupply()
    await ctx.vault.connect(ctx.guardian).pause()
    await ctx.vault.connect(ctx.lp1).requestRedeem(supply, ctx.lp1.address, ctx.lp1.address)
    const id = await closeRedeem(ctx, await ctx.vault.currentRedeemEpochId())
    const att = await freshAttestation(ctx.vault, id, PRICE_1)
    const sigs = await attestationSignatures(ctx, att)
    // Signed at par; the gain arrives before settle. Paused pays live, so the
    // fee must see live too, or the last redeemer leaves with it untaxed.
    await gain(ctx, usdt(100_000n))
    await ctx.vault.settleRedeemEpoch(id, att, ...sigs)

    const total = math.performanceFeeShares(await ctx.vault.freeSettlement() + (await ctx.vault.reservedSettlement()), supply, WAD, PERF)
    const { operatorShares } = math.splitFee(total, PROTOCOL_FEE_SHARE_WAD)
    expect(operatorShares).to.be.gt(0)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(operatorShares)
  })

  it('raises the mark so a flat period is never charged twice', async function () {
    const ctx = await seeded()
    await gain(ctx, usdt(100_000n))
    await checkpoint(ctx)
    const afterFirst = await ctx.vault.balanceOf(ctx.feeRecipient.address)
    expect(afterFirst).to.be.gt(0)
    expect(await ctx.vault.highWaterMarkWad()).to.be.gt(WAD)

    await checkpoint(ctx)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(afterFirst)
  })

  it('leaves the mark alone through a drawdown, so only the new peak is charged', async function () {
    // Corridor inventory is what lets NAV fall here: the attested price is the
    // only lever a test has on the value of what the vault holds.
    const ctx = await seeded({ minDepositCorridor: cngn(1n) })
    await ctx.corridor.mint(ctx.lp1.address, cngn(1_000_000n))
    await ctx.corridor.connect(ctx.lp1).approve(await ctx.vault.getAddress(), cngn(1_000_000n))
    await ctx.vault
      .connect(ctx.lp1)
      .requestDepositCorridor(cngn(1_000_000n), ctx.lp1.address, ctx.lp1.address)
    await closeAndProcessDeposit(ctx, await ctx.vault.currentCorridorDepositEpochId(), PRICE_1)

    // Peak: corridor marked up 20%.
    await checkpoint(ctx, (PRICE_1 * 12n) / 10n)
    const atPeak = await ctx.vault.balanceOf(ctx.feeRecipient.address)
    const peakMark = await ctx.vault.highWaterMarkWad()
    expect(atPeak).to.be.gt(0)

    // Drawdown, back under the mark. Nothing accrues and the bar holds.
    await checkpoint(ctx, (PRICE_1 * 9n) / 10n)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(atPeak)
    expect(await ctx.vault.highWaterMarkWad()).to.equal(peakMark)

    // Recovery to just under the old peak still owes nothing.
    await checkpoint(ctx, (PRICE_1 * 115n) / 100n)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(atPeak)
  })

  // The cap math itself is covered in VaultPolicy.test; this is the wiring
  // from VaultInit through the factory to the immutables.
  it('takes deployer-set rates up to the caps and refuses more', async function () {
    const caps = {
      managementFeeWad: math.MAX_MANAGEMENT_FEE_WAD,
      performanceFeeWad: math.MAX_PERFORMANCE_FEE_WAD,
    }
    const ctx = await deployOperatorVault(caps)
    expect(await ctx.vault.managementFeeWad()).to.equal(caps.managementFeeWad)
    expect(await ctx.vault.performanceFeeWad()).to.equal(caps.performanceFeeWad)

    for (const field of Object.keys(caps) as Array<keyof typeof caps>) {
      const init = { ...defaultInit(ctx, caps), operatorAdmin: ctx.other.address }
      init.settlementAsset = await ctx.settlement.getAddress()
      init.corridorAsset = await ctx.corridor.getAddress()
      init[field] = caps[field] + 1n
      await expect(ctx.factory.connect(ctx.other).deployVault(init)).to.be.reverted
    }
  })
})
