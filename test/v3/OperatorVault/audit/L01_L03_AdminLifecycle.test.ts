/**
 * Audit regressions — L-01 and L-03 (Resolved)
 *
 * L-01: admin transfers were single-step and took effect immediately, and
 * nothing stopped one entity from holding both admin roles — which would let
 * it rotate both signers and collapse the dual-signature model to a single
 * party. Both admin transfers are now two-step (propose + accept by the new
 * key, zero withdraws the proposal), `validateConfig` rejects
 * `operatorAdmin == riskAdmin` at deploy, and the separation is re-checked at
 * accept time.
 *
 * L-03: `acceptRiskSigner` is permissionless once the delay elapses and there
 * was no way to withdraw a proposal. `proposeRiskSigner(address(0))` now
 * closes that window.
 *
 * The behavioural matrix (two-step handover, zero-cancel, role separation
 * across a propose/accept race, signer withdrawal inside the L-03 window)
 * lives in `OperatorVault.Admin.test.ts`. This file pins the one scenario
 * only the factory deploy path can prove.
 */
import { expect } from 'chai'

import { defaultInit, deployOperatorVault } from '../fixtures/operatorVault.fixture'

describe('AUDIT L-01/L-03 — admin lifecycle hardening', function () {
  it('rejects a deploy where one entity holds both admin roles', async function () {
    const ctx = await deployOperatorVault()
    const init = defaultInit(ctx)
    init.settlementAsset = await ctx.settlement.getAddress()
    init.corridorAsset = await ctx.corridor.getAddress()
    // Fresh (admin, pair) tuple so the duplicate-vault check does not trigger.
    init.operatorAdmin = ctx.other.address
    init.riskAdmin = ctx.other.address
    await expect(ctx.factory.connect(ctx.other).deployVault(init)).to.be.revertedWithCustomError(
      ctx.vault,
      'InvalidParams'
    )
  })
})
