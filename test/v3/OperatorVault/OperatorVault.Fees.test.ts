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
import {
  closeAndSettleRedeem,
  closeDeposit,
  closeRedeem,
  exitAll,
  seedCorridorShares,
  seedShares,
} from './helpers/vaultLifecycle'
import { freshAttestation, attestationSignatures } from './helpers/vaultSignatures'

describe('OperatorVault — management fee', function () {
  it('banks the fee at the pause and charges nothing more at a paused settle', async function () {
    // Settling a year after close needs an emergency window that long: an
    // attestation can't be used once the epoch could only exit in kind.
    const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n, emergencyExitTimeout: 400 * DAY })
    await seedShares(ctx, ctx.lp1)

    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1_000n), ctx.lp1.address, ctx.lp1.address)
    const redeemId = await ctx.vault.currentRedeemEpochId()
    await closeRedeem(ctx, redeemId)
    await ctx.vault.connect(ctx.guardian).pause()
    const banked = await ctx.vault.balanceOf(ctx.feeRecipient.address)
    expect(banked).to.be.gt(0)

    await time.increase(365 * DAY)
    const att = await freshAttestation(ctx.vault, redeemId, PRICE_1)
    const sigs = await attestationSignatures(ctx, att)
    await ctx.vault.settleRedeemEpoch(redeemId, att, ...sigs)

    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(banked)
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

  // The fee is earned for time the vault is open for business. A pause stops
  // the clock, and the emergency exit, which only runs once the operator has
  // missed the epoch, does not pay the operator for the time it missed.
  describe('accrues only while the vault is open for business', function () {
    it('charges nothing for the time the vault spends paused', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      await seedShares(ctx, ctx.lp1)
      await ctx.vault.connect(ctx.guardian).pause()
      const supply = await ctx.vault.totalSupply()

      // A year on pause, and a checkpoint in the middle of it: nothing is minted.
      await time.increase(365 * DAY)
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.feeRecipient.address)
      expect(await ctx.vault.totalSupply()).to.equal(supply)

      // Accrual restarts at the unpause, so a year later a checkpoint charges one year, not two.
      await ctx.vault.connect(ctx.guardian).unpause()
      const unpausedAt = BigInt(await time.latest())
      await time.increase(365 * DAY)
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.feeRecipient.address)
      const oneYear = math.feeShares(
        supply,
        WAD / 10n,
        (await ctx.vault.lastFeeCheckpoint()) - unpausedAt
      )
      expect(oneYear).to.be.gt(0)
      expect((await ctx.vault.totalSupply()) - supply).to.equal(oneYear)
    })

    it('forfeits the period the emergency exit covers', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      await seedShares(ctx, ctx.lp1)
      const supply = await ctx.vault.totalSupply()
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(500n), ctx.lp1.address, ctx.lp1.address)
      const redeemId = await closeRedeem(ctx)
      await time.increase(await ctx.vault.emergencyExitTimeout())

      // The operator never attested this epoch. The redeemers are paid from an
      // undiluted supply, and nobody is paid for the time since the last checkpoint.
      const tx = ctx.vault.connect(ctx.lp2).settleRedeemEmergencyInKind(redeemId)
      await expect(tx)
        .to.emit(ctx.vault, 'RedeemEpochSettled')
        .withArgs(redeemId, usdt(500n), usdt(500n), 0n)
      await expect(tx).to.not.emit(ctx.vault, 'FeeAccrued')
      expect(await ctx.vault.totalSupply()).to.equal(supply - usdt(500n))
    })

    it('banks what accrued before a guardian pause', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      await seedShares(ctx, ctx.lp1)
      const supply = await ctx.vault.totalSupply()
      const t0 = await ctx.vault.lastFeeCheckpoint()
      await time.increase(365 * DAY)

      const positive = (n: bigint) => n > 0n
      await expect(ctx.vault.connect(ctx.guardian).pause())
        .to.emit(ctx.vault, 'FeeAccrued')
        .withArgs(ctx.feeRecipient.address, positive, positive)
      const whole = math.feeShares(supply, WAD / 10n, (await ctx.vault.lastFeeCheckpoint()) - t0)
      expect((await ctx.vault.totalSupply()) - supply).to.equal(whole)
    })

    it('keeps what a guardian pause banked when the emergency exit follows', async function () {
      const ctx = await deployOperatorVault({ managementFeeWad: WAD / 10n })
      await seedShares(ctx, ctx.lp1)
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(500n), ctx.lp1.address, ctx.lp1.address)
      const redeemId = await closeRedeem(ctx)
      await ctx.vault.connect(ctx.guardian).pause()
      const supply = await ctx.vault.totalSupply()
      const banked = await ctx.vault.balanceOf(ctx.feeRecipient.address)
      expect(banked).to.be.gt(0)

      // Only the span since the pause is forfeited, and nothing accrued in it anyway.
      await time.increase(await ctx.vault.emergencyExitTimeout())
      await expect(ctx.vault.settleRedeemEmergencyInKind(redeemId)).to.not.emit(ctx.vault, 'FeeAccrued')
      expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(banked)
      expect(await ctx.vault.totalSupply()).to.equal(supply - usdt(500n))
    })
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
    // Net of the management leg: the mark is per share, so the minted
    // management shares lift the bar by their share of the seed.
    const gain = navAssets - math.perShareTotal(WAD, supply + mgmt)
    const perf = math.performanceFeeShares(navAssets, supply + mgmt, gain, WAD / 5n)
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

      // Below the floor, both residue holders may queue; an LP's partial request may not.
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
      // A year's fee, banked by the pause. The paused settles below mint nothing more.
      await time.increase(365 * DAY)
      await ctx.vault.connect(ctx.guardian).pause()

      // Everyone ahead of the protocol recipient leaves: the LP, then the
      // operator's recipient.
      await exitAll(ctx, [ctx.lp1, ctx.feeRecipient])

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

    // Exact because a paused exit epoch accrues nothing, so the queued shares
    // really are the whole supply. The totalSupply assertion pins that premise;
    // the one-pass test below does the same at a size where an unpaused
    // checkpoint would mint.
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
     * Big enough that an unpaused settle-time checkpoint mints. That used to
     * leave a fresh below-floor tail after every exit pass, so the wind-down
     * converged rather than completed. A paused epoch accrues nothing, so the
     * exit takes one pass: the pause banks what little accrued since the LP's
     * settle, and the settle pays the whole supply out.
     */
    it('completes in one pass, since a paused exit epoch accrues no new tail', async function () {
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
      const before = await ctx.settlement.balanceOf(ctx.feeRecipient.address)

      await ctx.vault.connect(ctx.guardian).pause()
      expect(await exitFee(ctx)).to.equal(0)

      expect((await ctx.settlement.balanceOf(ctx.feeRecipient.address)) - before).to.equal(stranded)
      expect(await ctx.vault.totalSupply()).to.equal(0)
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

    it('does not lift the floor for a partial redeem', async function () {
      const ctx = await windDown()
      await seedShares(ctx, ctx.lp2, usdt(150n))
      const held = await ctx.vault.balanceOf(ctx.lp2.address)
      await expect(
        ctx.vault.connect(ctx.lp2).requestRedeem(usdt(50n), ctx.lp2.address, ctx.lp2.address)
      ).to.be.revertedWithCustomError(ctx.vault, 'BelowMinSize')
      await ctx.vault.connect(ctx.lp2).requestRedeem(held, ctx.lp2.address, ctx.lp2.address)
    })

    // The residue is the old recipient's whole balance, and it has no other
    // way out once the role has moved on.
    it('lets the old recipient queue its residue after a change', async function () {
      const ctx = await windDown()
      const old = ctx.feeRecipient
      const held = await ctx.vault.balanceOf(old.address)
      await ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address)

      await ctx.vault.connect(old).requestRedeem(held, old.address, old.address)
      expect(await ctx.vault.balanceOf(old.address)).to.equal(0)
    })
  })
})

describe('OperatorVault — performance fee', function () {
  const PERF = WAD / 5n // 20% of the chargeable gain
  const SEED = usdt(1_000_000n)
  const SETTLEMENT_DECIMALS = 6
  const CORRIDOR_DECIMALS = 18

  /** A vault holding `SEED`, no management fee, both marks sitting at par. */
  async function seeded(
    extras: { perfFloorEnabled?: boolean; minDepositCorridor?: bigint } = {}
  ): Promise<DeployedVault> {
    const ctx = await deployOperatorVault({
      performanceFeeWad: PERF,
      minRedeemShares: usdt(1n),
      ...extras,
    })
    await seedShares(ctx, ctx.lp1, SEED)
    return ctx
  }

  /** `seeded`, plus a matching corridor deposit at par: a 50/50 book of 2M. */
  async function fiftyFifty(perfFloorEnabled: boolean): Promise<DeployedVault> {
    const ctx = await seeded({ minDepositCorridor: cngn(1n), perfFloorEnabled })
    await seedCorridorShares(ctx, ctx.lp1, cngn(1_000_000n))
    return ctx
  }

  /** Settlement the vault did not get from a deposit: a gain, as the fee sees it. */
  async function gain(ctx: DeployedVault, amount: bigint): Promise<void> {
    await ctx.settlement.mint(await ctx.vault.getAddress(), amount)
  }

  /** Run one priced checkpoint by settling a token-sized redeem. */
  async function checkpoint(ctx: DeployedVault, price: bigint = PRICE_1): Promise<void> {
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1n), ctx.lp1.address, ctx.lp1.address)
    await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId(), price)
  }

  /** Performance shares minted so far, both recipients together. */
  async function perfMinted(ctx: DeployedVault): Promise<bigint> {
    const [operator, protocol] = await Promise.all([
      ctx.vault.balanceOf(ctx.feeRecipient.address),
      ctx.vault.balanceOf(ctx.protocolFeeRecipient.address),
    ])
    return operator + protocol
  }

  async function basketOf(ctx: DeployedVault): Promise<math.BasketMark> {
    const mark = await ctx.vault.basketMark()
    return { settlementWad: mark.settlementWad, corridorWad: mark.corridorWad }
  }

  /** What the next priced checkpoint at `price` would see and mint, from the vault's own state. */
  async function outlook(ctx: DeployedVault, price: bigint) {
    const [supply, freeS, freeC, basket, floor, markWad] = await Promise.all([
      ctx.vault.totalSupply(),
      ctx.vault.freeSettlement(),
      ctx.vault.freeCorridor(),
      basketOf(ctx),
      ctx.vault.perfFloorEnabled(),
      ctx.vault.highWaterMarkWad(),
    ])
    const navNow = math.nav(freeS, freeC, price, SETTLEMENT_DECIMALS, CORRIDOR_DECIMALS)
    const basketValue = math.nav(
      math.perShareTotal(basket.settlementWad, supply),
      math.perShareTotal(basket.corridorWad, supply),
      price,
      SETTLEMENT_DECIMALS,
      CORRIDOR_DECIMALS
    )
    const basketGain = navNow > basketValue ? navNow - basketValue : 0n
    const absValue = floor ? math.perShareTotal(markWad, supply) : 0n
    const chargeable = math.chargeableGain(navNow, basketValue, absValue)
    return {
      supply,
      navNow,
      basketGain,
      chargeable,
      shares: math.performanceFeeShares(navNow, supply, chargeable, PERF),
      // NAV net of the fee still owed on the basket gain: what the holders keep between them.
      attributable: navNow - (basketGain * PERF) / WAD,
    }
  }

  it('starts both marks at par and charges nothing before a gain', async function () {
    const ctx = await seeded()
    await checkpoint(ctx)

    expect(await perfMinted(ctx)).to.equal(0)
    expect(await ctx.vault.highWaterMarkWad()).to.equal(WAD)
    // The seed deposit set the basket: one settlement atom per share, no corridor.
    expect(await basketOf(ctx)).to.deep.equal({ settlementWad: WAD, corridorWad: 0n })
  })

  it('takes its cut of a settlement gain, leaves the LP 80% of it, and rebases the basket', async function () {
    const ctx = await seeded()
    const supply = await ctx.vault.totalSupply()
    await gain(ctx, usdt(100_000n))
    const navAssets = await ctx.vault.freeSettlement()

    await checkpoint(ctx)

    // The performance leg is split with the protocol on the same terms as the
    // management leg, so the operator's recipient sees its share of the whole.
    const total = math.performanceFeeShares(navAssets, supply, usdt(100_000n), PERF)
    const { operatorShares } = math.splitFee(total, PROTOCOL_FEE_SHARE_WAD)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(operatorShares)
    expect(await perfMinted(ctx)).to.equal(total)

    // The whole point of minting against post-fee NAV: the LP keeps exactly
    // 80% of the 100k gain, not 80%/(1+20%) of it. Dilution is the same total
    // either way — how the fee is split does not change what the LP bears.
    const lpValue = (SEED * navAssets) / (supply + total)
    expect(lpValue).to.be.closeTo(SEED + usdt(80_000n), usdt(1n))

    // Charged in full, the basket is the post-fee inventory per share.
    expect(await basketOf(ctx)).to.deep.equal({
      settlementWad: math.basketPerShare(navAssets, supply + total),
      corridorWad: 0n,
    })
    expect((await outlook(ctx, PRICE_1)).chargeable).to.equal(0)
  })

  it('emits the marks when they move, and only then', async function () {
    const ctx = await seeded()
    await gain(ctx, usdt(100_000n))
    const settle = async () => {
      await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1n), ctx.lp1.address, ctx.lp1.address)
      const id = await closeRedeem(ctx, await ctx.vault.currentRedeemEpochId())
      const att = await freshAttestation(ctx.vault, id, PRICE_1)
      return ctx.vault.settleRedeemEpoch(id, att, ...(await attestationSignatures(ctx, att)))
    }
    await expect(settle()).to.emit(ctx.vault, 'MarkUpdated')
    expect(await ctx.vault.highWaterMarkWad()).to.be.gt(WAD)
    await expect(settle()).to.not.emit(ctx.vault, 'MarkUpdated')
  })

  it('refuses an attestation that charges on a NAV its floors would not pay', async function () {
    // Two colluding keys could sign a full NAV for the fee leg with near-zero floors for redeemers.
    const ctx = await seeded()
    await gain(ctx, usdt(100_000n))
    await ctx.vault.connect(ctx.lp1).requestRedeem(usdt(1n), ctx.lp1.address, ctx.lp1.address)
    const id = await closeRedeem(ctx, await ctx.vault.currentRedeemEpochId())
    const att = await freshAttestation(ctx.vault, id, PRICE_1)
    att.freeSettlement = 0n
    const sigs = await attestationSignatures(ctx, att)
    await expect(ctx.vault.settleRedeemEpoch(id, att, ...sigs)).to.be.revertedWithCustomError(
      ctx.vault,
      'InvalidAttestation'
    )
    expect(await perfMinted(ctx)).to.equal(0)
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

    const live = (await ctx.vault.freeSettlement()) + (await ctx.vault.reservedSettlement())
    const total = math.performanceFeeShares(live, supply, live - SEED, PERF)
    const { operatorShares } = math.splitFee(total, PROTOCOL_FEE_SHARE_WAD)
    expect(operatorShares).to.be.gt(0)
    expect(await ctx.vault.balanceOf(ctx.feeRecipient.address)).to.equal(operatorShares)
  })

  it('raises the absolute mark so a flat period is never charged twice', async function () {
    const ctx = await seeded()
    await gain(ctx, usdt(100_000n))
    await checkpoint(ctx)
    const afterFirst = await perfMinted(ctx)
    expect(afterFirst).to.be.gt(0)
    expect(await ctx.vault.highWaterMarkWad()).to.be.gt(WAD)

    await checkpoint(ctx)
    expect(await perfMinted(ctx)).to.equal(afterFirst)
  })

  for (const floor of [true, false]) {
    describe(`with the floor ${floor ? 'on' : 'off'}`, function () {
      it('charges nothing on an FX round trip over a fixed inventory', async function () {
        // 50/50 book: +10%, par, +10%. The revalued basket moves with NAV, so nothing is performance.
        const ctx = await fiftyFifty(floor)
        const basket = await basketOf(ctx)
        expect(basket.settlementWad).to.be.gt(0)
        expect(basket.corridorWad).to.be.gt(0)

        for (const price of [(PRICE_1 * 11n) / 10n, PRICE_1, (PRICE_1 * 11n) / 10n]) {
          await checkpoint(ctx, price)
          expect(await perfMinted(ctx), `at price ${price}`).to.equal(0)
          expect(await basketOf(ctx)).to.deep.equal(basket)
        }
        // The absolute mark still ratchets on the FX peak in both modes.
        expect(await ctx.vault.highWaterMarkWad()).to.be.gt(WAD)
      })

      it(
        floor
          ? 'defers trading gain while the vault is under its high, then charges it once'
          : 'charges trading gain under the high at once, and not again on the recovery',
        async function () {
          const ctx = await fiftyFifty(floor)
          const basket = await basketOf(ctx)
          const down = (PRICE_1 * 8n) / 10n

          // Corridor down 20% and 50k earned: gain over the basket, nothing over the absolute mark.
          await gain(ctx, usdt(50_000n))
          const before = await outlook(ctx, down)
          expect(before.basketGain).to.equal(usdt(50_000n))
          expect(before.chargeable).to.equal(floor ? 0n : usdt(50_000n))
          await checkpoint(ctx, down)
          expect(await perfMinted(ctx)).to.equal(before.shares)
          if (floor) expect(await basketOf(ctx)).to.deep.equal(basket)

          // Back to par. Floor on: at the high again, the deferred 50k is charged (less the
          // sliver the token-sized redeem carried out). Floor off: the recovery is FX, not performance.
          const recovered = await outlook(ctx, PRICE_1)
          if (floor) {
            expect(recovered.chargeable).to.equal(recovered.basketGain)
            expect(recovered.chargeable).to.be.closeTo(usdt(50_000n), usdt(1n))
          } else {
            expect(recovered.shares).to.equal(0)
          }
          await checkpoint(ctx, PRICE_1)
          expect(await perfMinted(ctx)).to.equal(before.shares + recovered.shares)

          // Once, not twice.
          await checkpoint(ctx, PRICE_1)
          expect(await perfMinted(ctx)).to.equal(before.shares + recovered.shares)
        }
      )

      it(
        floor
          ? 'charges what the floor allows and keeps the rest owed for later'
          : 'charges the whole basket gain when the floor is off',
        async function () {
          const ctx = await fiftyFifty(floor)
          const dip = (PRICE_1 * 97n) / 100n

          // Basket gain 50k, absolute gain 20k: the corridor leg lost 30k on FX.
          await gain(ctx, usdt(50_000n))
          const first = await outlook(ctx, dip)
          expect(first.basketGain).to.equal(usdt(50_000n))
          expect(first.chargeable).to.equal(floor ? usdt(20_000n) : usdt(50_000n))
          await checkpoint(ctx, dip)
          expect(await perfMinted(ctx)).to.equal(first.shares)

          // Flat: nothing mints. Floor on, the 30k still owed is untouched.
          const flat = await outlook(ctx, dip)
          expect(flat.basketGain).to.be.closeTo(floor ? usdt(30_000n) : 0n, usdt(1n))
          expect(flat.shares).to.equal(0)
          await checkpoint(ctx, dip)
          expect(await perfMinted(ctx)).to.equal(first.shares)

          // Back at par. Floor on: the remaining 30k is charged, unmoved by the corridor price
          // because the charged slice sat on the settlement leg. Floor off: FX, not performance.
          const cleared = await outlook(ctx, PRICE_1)
          expect(cleared.chargeable).to.be.closeTo(floor ? usdt(30_000n) : 0n, usdt(1n))
          await checkpoint(ctx, PRICE_1)
          expect(await perfMinted(ctx)).to.equal(first.shares + cleared.shares)
          expect((await outlook(ctx, PRICE_1)).shares).to.equal(0)
        }
      )

      describe('deposits under an outstanding gain', function () {
        /** A 50/50 book, corridor down 10%, 50k earned; deferred when the floor is on. */
        async function outstanding() {
          const ctx = await fiftyFifty(floor)
          const down = (PRICE_1 * 9n) / 10n
          await gain(ctx, usdt(50_000n))
          await checkpoint(ctx, down)
          const before = await outlook(ctx, down)
          expect(before.basketGain).to.be.closeTo(floor ? usdt(50_000n) : 0n, usdt(1n))
          expect(before.shares).to.equal(0)
          return { ctx, down, before }
        }

        it('does not hand the entrant a slice of the gain to be charged for', async function () {
          const { ctx, down, before } = await outstanding()
          const charged = await perfMinted(ctx)

          // A new LP buys half the vault at the depressed price.
          await ctx.settlement.mint(ctx.lp2.address, before.navNow)
          await seedShares(ctx, ctx.lp2, before.navNow, down)
          const after = await outlook(ctx, down)
          expect(after.attributable - before.attributable).to.equal(before.navNow)
          // Same basket gain in atoms; a per-share basket left alone would have doubled it.
          expect(after.basketGain).to.equal(before.basketGain)

          // Corridor recovers past par. Floor on: the fee is 20% of the 50k earned before
          // the entrant arrived, not of 100k. Floor off: it was charged before they arrived.
          const up = (PRICE_1 * 105n) / 100n
          const cleared = await outlook(ctx, up)
          if (floor) expect(cleared.chargeable).to.equal(before.basketGain)
          else expect(cleared.shares).to.equal(0)
          await checkpoint(ctx, up)
          expect(await perfMinted(ctx)).to.equal(charged + cleared.shares)

          // Half the shares, half the dilution of a fee already owed when they bought in.
          const lp2Value =
            ((await ctx.vault.balanceOf(ctx.lp2.address)) * cleared.navNow) /
            (cleared.supply + cleared.shares)
          const half = (cleared.navNow - (cleared.chargeable * PERF) / WAD) / 2n
          expect(lp2Value).to.be.closeTo(half, usdt(1n))
        })

        it('moves what the holders keep by exactly the deposit, in either asset', async function () {
          const { ctx, down, before } = await outstanding()

          await seedShares(ctx, ctx.lp2, usdt(300_000n), down)
          const afterSettlement = await outlook(ctx, down)
          expect(afterSettlement.attributable - before.attributable).to.equal(usdt(300_000n))

          await seedCorridorShares(ctx, ctx.lp2, cngn(200_000n), down)
          const afterCorridor = await outlook(ctx, down)
          const corridorValue = math.nav(0n, cngn(200_000n), down, SETTLEMENT_DECIMALS, CORRIDOR_DECIMALS)
          expect(afterCorridor.attributable - afterSettlement.attributable).to.equal(corridorValue)
          expect(afterCorridor.basketGain).to.equal(before.basketGain)
        })
      })
    })
  }

  describe('empty vault and bootstrap', function () {
    /** Everyone out through a paused settle, so supply hits zero. */
    async function emptyOut(ctx: DeployedVault): Promise<void> {
      await ctx.vault.connect(ctx.guardian).pause()
      await exitAll(ctx, [ctx.lp1, ctx.feeRecipient, ctx.protocolFeeRecipient])
      expect(await ctx.vault.totalSupply()).to.equal(0)
    }

    it('resets both marks once the vault is empty', async function () {
      const ctx = await seeded()
      await gain(ctx, usdt(100_000n))
      await checkpoint(ctx)
      expect(await ctx.vault.highWaterMarkWad()).to.be.gt(WAD)
      await emptyOut(ctx)

      // The reset lands on the next checkpoint of any kind; this one is unpriced.
      await expect(ctx.vault.connect(ctx.operatorAdmin).setFeeRecipient(ctx.other.address))
        .to.emit(ctx.vault, 'MarkUpdated')
        .withArgs(WAD, 0n, 0n)
      expect(await ctx.vault.highWaterMarkWad()).to.equal(WAD)
      expect(await basketOf(ctx)).to.deep.equal({ settlementWad: 0n, corridorWad: 0n })
    })

    it('initialises a fresh basket to the attested inventory and charges nothing on it', async function () {
      const ctx = await seeded()
      await emptyOut(ctx)
      await ctx.vault.connect(ctx.guardian).unpause()
      // Surplus in the empty vault becomes the first depositor's NAV (audit H-02), not performance.
      await gain(ctx, usdt(10_000n))
      await seedShares(ctx, ctx.lp2, usdt(100_000n))

      expect(await basketOf(ctx)).to.deep.equal({
        settlementWad: math.basketPerShare(usdt(110_000n), usdt(100_000n)),
        corridorWad: 0n,
      })
      await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(1n), ctx.lp2.address, ctx.lp2.address)
      await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId())
      expect(await perfMinted(ctx)).to.equal(0)
    })

    it('leaves a surplus that arrives after the attestation chargeable on a fresh basket', async function () {
      const ctx = await seeded()
      await emptyOut(ctx)
      await ctx.vault.connect(ctx.guardian).unpause()

      await ctx.vault
        .connect(ctx.lp2)
        .requestDeposit(usdt(100_000n), ctx.lp2.address, ctx.lp2.address)
      const depositId = await closeDeposit(ctx)
      // Signed over an empty vault; the 10k lands before the epoch is processed, so the
      // checkpoint never prices it (audit F-05).
      const att = await freshAttestation(ctx.vault, depositId, PRICE_1)
      const sigs = await attestationSignatures(ctx, att)
      await gain(ctx, usdt(10_000n))
      await ctx.vault.processDepositEpoch(depositId, att, ...sigs)
      await ctx.vault.connect(ctx.lp2).claim(depositId, ctx.lp2.address, ctx.lp2.address)

      // The basket is the deposit alone, not the 110k sitting in the vault.
      const supply = await ctx.vault.totalSupply()
      expect(await basketOf(ctx)).to.deep.equal({
        settlementWad: math.basketPerShare(usdt(100_000n), supply),
        corridorWad: 0n,
      })

      const due = await outlook(ctx, PRICE_1)
      expect(due.basketGain).to.equal(usdt(10_000n))
      expect(due.shares).to.be.gt(0)
      await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(1n), ctx.lp2.address, ctx.lp2.address)
      await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId())
      expect(await perfMinted(ctx)).to.equal(due.shares)
    })

    it('folds a deposit after a wind-down residue into the basket without charging', async function () {
      // The last LP leaves; the fee's own dilution stays behind, under the floor.
      const ctx = await seeded()
      await gain(ctx, usdt(100_000n))
      await checkpoint(ctx)
      const residueFee = await perfMinted(ctx)
      await exitAll(ctx, [ctx.lp1])
      expect(await ctx.vault.totalSupply()).to.equal(residueFee)

      await seedShares(ctx, ctx.lp2, usdt(100_000n))
      expect((await outlook(ctx, PRICE_1)).shares).to.equal(0)
      await ctx.vault.connect(ctx.lp2).requestRedeem(usdt(1n), ctx.lp2.address, ctx.lp2.address)
      await closeAndSettleRedeem(ctx, await ctx.vault.currentRedeemEpochId())
      expect(await perfMinted(ctx)).to.equal(residueFee)
    })
  })

  it('fixes the floor at deploy', async function () {
    const ctx = await deployOperatorVault({ perfFloorEnabled: true })
    expect(await ctx.vault.perfFloorEnabled()).to.equal(true)
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
