/**
 * Audit proof — L-05 (bonus proof; Low severity)
 *
 * `SellFirstFeeController.getFeeOutputs` reverts `FeeRoundsToZero` whenever a
 * per-token fee rounds down to zero (`output * FEE_BPS / 10_000 == 0`). The
 * vendored reactor calls the controller on the hot path of every fill
 * (`ProtocolFees._injectFees`), and `VaultOrderExecutor._outputFee` calls it
 * again to size the funding pull. A revert inside the fee hook reverts the
 * entire fill.
 *
 * So a fill whose output is small enough that the fee rounds to zero cannot be
 * settled while this controller is active — through the executor or a direct
 * reactor call. The safer behaviour is to skip a zero fee, not revert. Impact
 * is limited to dust-sized outputs, hence Low. Status: Unresolved.
 */
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { encodeLimitOrder } from '../../helpers/limitOrderPermit2'
import { CANONICAL_PERMIT2, cngn, deployOperatorVault, usdt } from '../fixtures/operatorVault.fixture'
import { seedShares } from '../helpers/vaultLifecycle'
import { signVaultEnvelope } from '../helpers/vaultSignatures'

describe('AUDIT L-05 — SellFirstFeeController reverts fills whose fee rounds to zero', function () {
  it('bricks an executor fill with a dust output (fee = output * 5bps rounds to 0)', async function () {
    const ctx = await deployOperatorVault({ realUniswapX: true })
    await seedShares(ctx, ctx.lp1, usdt(10_000n))
    const Executor = await ethers.getContractFactory('VaultOrderExecutor')
    const executor = await Executor.deploy(ctx.reactor, await ctx.factory.getAddress())
    const executorAddr = await executor.getAddress()

    const Controller = await ethers.getContractFactory('SellFirstFeeController')
    const controller = await Controller.deploy(ctx.feeRecipient.address, 5)
    const reactor = await ethers.getContractAt('LimitOrderReactor', ctx.reactor)
    await reactor.connect(ctx.deployer).setProtocolFeeController(await controller.getAddress())

    // output 1000 wei corridor -> fee = 1000 * 5 / 10_000 = 0 -> FeeRoundsToZero
    const block = await ethers.provider.getBlock('latest')
    const epoch = await ctx.vault.tradingEpoch()
    const { params } = await signVaultEnvelope(ctx.strategy, ctx.risk, {
      reactor: ctx.reactor,
      vault: ctx.vault.target as string,
      permit2: CANONICAL_PERMIT2,
      chainId: 31337,
      nonce: (epoch << 128n) | 1n,
      deadline: BigInt(block!.timestamp + 600),
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(1_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: 1000n,
      preferredFiller: ctx.preferredFiller,
      taker: ctx.other.address,
      // fill() only lets a bound filler call it, so the caller must be listed
      // for this to reach the fee hook the test is about.
      fillers: [ctx.other.address, executorAddr],
    })
    await ctx.corridor.mint(ctx.other.address, cngn(1n))
    await ctx.corridor.connect(ctx.other).approve(executorAddr, ethers.MaxUint256)

    await expect(
      executor.connect(ctx.other).fill({ order: encodeLimitOrder(params), sig: '0x' })
    ).to.be.revertedWithCustomError(controller, 'FeeRoundsToZero')
  })
})
