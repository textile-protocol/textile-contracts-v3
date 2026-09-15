/**
 * Audit proof — executor DoS via the reactor's native refund
 * (reported after the v0.1 OperatorVault review; not numbered in that report)
 *
 * `BaseReactor._fill` ends every execute by refunding the reactor's whole
 * native balance to `msg.sender` and reverts if that fails. The reactor has an
 * open `receive()`. `VaultOrderExecutor` is the reactor's `msg.sender` for
 * vault fills and had no `receive()`, so 1 wei sent to the reactor reverted
 * every `executor.fill()` with `NativeTransferFailed` — and kept doing so until
 * an EOA filled a direct order and took the dust as its own refund. Direct EOA
 * fills were never affected.
 *
 * Fix: the executor accepts native and passes it on to the caller, best effort.
 */
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { cngn, usdt } from '../fixtures/operatorVault.fixture'
import {
  deployExecutorContext,
  signedExecutorOrder,
  type ExecutorContext,
} from '../helpers/executor'

describe('AUDIT — reactor native refund DoS on VaultOrderExecutor', function () {
  function order(ctx: ExecutorContext, taker: string) {
    return signedExecutorOrder(ctx, {
      inputToken: ctx.settlement.target as string,
      inputAmount: usdt(1_000n),
      outputToken: ctx.corridor.target as string,
      outputAmount: cngn(1_000n),
      taker,
    })
  }

  async function dustReactor(ctx: ExecutorContext, wei: bigint) {
    // Anyone can: the vendored reactor has an open receive().
    await ctx.other.sendTransaction({ to: ctx.reactor, value: wei })
  }

  it('a 1 wei dust on the reactor does not brick executor fills', async function () {
    const ctx = await deployExecutorContext()
    const executorAddr = await ctx.executor.getAddress()
    const filler = ctx.lp2
    await dustReactor(ctx, 1n)

    await ctx.corridor.mint(filler.address, cngn(1_000n))
    await ctx.corridor.connect(filler).approve(executorAddr, ethers.MaxUint256)

    // Before the fix this reverted with CurrencyLibrary.NativeTransferFailed:
    // the reactor tried to refund 1 wei to an executor that could not take it.
    const before = await ctx.settlement.balanceOf(filler.address)
    await expect(
      ctx.executor.connect(filler).fill(await order(ctx, filler.address))
    ).to.changeEtherBalances([filler, ctx.reactor, executorAddr], [1n, -1n, 0n])
    expect((await ctx.settlement.balanceOf(filler.address)) - before).to.equal(
      usdt(1_000n)
    )
  })

  it('a caller whose fallback burns all gas still gets its fill; the dust waits for the next caller', async function () {
    const ctx = await deployExecutorContext()
    const executorAddr = await ctx.executor.getAddress()
    await dustReactor(ctx, 5n)

    // A contract filler whose receive() eats its whole gas allowance: the
    // pass-through fails, is swallowed, and can't starve the rest of the fill.
    const caller = await (
      await ethers.getContractFactory('GasBurningCallerMock')
    ).deploy()
    const callerAddr = await caller.getAddress()
    await ctx.corridor.mint(callerAddr, cngn(1_000n))
    await caller.exec(
      ctx.corridor.target,
      ctx.corridor.interface.encodeFunctionData('approve', [
        executorAddr,
        ethers.MaxUint256,
      ])
    )

    const before = await ctx.settlement.balanceOf(callerAddr)
    const tx = await caller.exec(
      executorAddr,
      ctx.executor.interface.encodeFunctionData('fill', [
        await order(ctx, callerAddr),
      ]),
      { gasLimit: 2_000_000n }
    )
    await expect(tx).to.emit(ctx.executor, 'ExecutorFill')
    expect((await ctx.settlement.balanceOf(callerAddr)) - before).to.equal(
      usdt(1_000n)
    )
    expect(await ethers.provider.getBalance(executorAddr)).to.equal(5n)
    // The burner only got the capped allowance, not the whole gas limit.
    expect((await tx.wait())!.gasUsed).to.be.lessThan(1_000_000n)

    // The next EOA caller drains it as part of its own fill.
    const eoa = ctx.lp2
    await ctx.corridor.mint(eoa.address, cngn(1_000n))
    await ctx.corridor.connect(eoa).approve(executorAddr, ethers.MaxUint256)
    await expect(
      ctx.executor.connect(eoa).fill(await order(ctx, eoa.address))
    ).to.changeEtherBalances([eoa, executorAddr], [5n, -5n])
  })
})
