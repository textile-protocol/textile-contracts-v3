/**
 * Audit regression — I-01 (in-house report v0.2, 2026-09-17)
 *
 * `processDepositEpoch` returns early when `epoch.assets == 0`, before
 * `verifyAttestation` runs. It used to emit `attestation.corridorAssetPrice`
 * into `DepositEpochProcessed`, so any caller — the entry point is
 * permissionless — could push an arbitrary unsigned price into the log and
 * poison anything indexing prices off that event. The branch now reports 0.
 */
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'

import {
  DAY,
  PRICE_1,
  deployOperatorVault,
  usdt,
} from '../fixtures/operatorVault.fixture'
import type { DeployedVault } from '../fixtures/operatorVault.fixture'
import { attestationSignatures, freshAttestation } from '../helpers/vaultSignatures'

const ABSURD_PRICE = PRICE_1 * 1_000_000n

/** Open a deposit epoch, empty it by cancelling, and close it. */
async function emptyClosedEpoch(ctx: DeployedVault): Promise<bigint> {
  const { vault, lp1 } = ctx
  await vault.connect(lp1).requestDeposit(usdt(100n), lp1.address, lp1.address)
  const epochId = await vault.currentDepositEpochId()
  await vault.connect(lp1).cancelDeposit(epochId, lp1.address)
  await time.increase(DAY)
  await vault.closeDepositEpoch(epochId)
  return epochId
}

describe('AUDIT I-01 — an empty deposit epoch reports no price', function () {
  it('ignores the attested price a stranger supplies with no signature', async function () {
    const ctx = await deployOperatorVault()
    const epochId = await emptyClosedEpoch(ctx)

    const att = await freshAttestation(ctx.vault, epochId, ABSURD_PRICE)
    await expect(
      ctx.vault.connect(ctx.other).processDepositEpoch(epochId, att, '0x', '0x')
    )
      .to.emit(ctx.vault, 'DepositEpochProcessed')
      .withArgs(epochId, 0, 0, 0)

    expect((await ctx.vault.epochs(epochId)).state).to.equal(3) // Processed
    expect(await ctx.vault.lastSettledNav()).to.equal(0)
    expect(await ctx.vault.totalSupply()).to.equal(0)
  })

  it('ignores it even when the price is properly signed', async function () {
    const ctx = await deployOperatorVault()
    const epochId = await emptyClosedEpoch(ctx)

    const att = await freshAttestation(ctx.vault, epochId, PRICE_1)
    const sigs = await attestationSignatures(ctx, att)
    await expect(ctx.vault.processDepositEpoch(epochId, att, ...sigs))
      .to.emit(ctx.vault, 'DepositEpochProcessed')
      .withArgs(epochId, 0, 0, 0)
  })

  it('still reports the signed price when the epoch actually converts', async function () {
    const ctx = await deployOperatorVault()
    const { vault, lp1 } = ctx
    await vault
      .connect(lp1)
      .requestDeposit(usdt(100n), lp1.address, lp1.address)
    const epochId = await vault.currentDepositEpochId()
    await time.increase(DAY)
    await vault.closeDepositEpoch(epochId)

    const att = await freshAttestation(vault, epochId, PRICE_1)
    const sigs = await attestationSignatures(ctx, att)
    await expect(vault.processDepositEpoch(epochId, att, ...sigs))
      .to.emit(vault, 'DepositEpochProcessed')
      .withArgs(epochId, usdt(100n), usdt(100n), PRICE_1)
  })
})
