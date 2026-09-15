import { ethers } from 'hardhat'

import { encodeLimitOrder } from '../../helpers/limitOrderPermit2'
import {
  CANONICAL_PERMIT2,
  deployOperatorVault,
  usdt,
  type DeployedVault,
} from '../fixtures/operatorVault.fixture'
import { seedShares } from './vaultLifecycle'
import { signVaultEnvelope } from './vaultSignatures'
import type { VaultOrderExecutor } from '../../../../typechain-types'

export interface ExecutorContext extends DeployedVault {
  executor: VaultOrderExecutor
}

let nonceCounter = 1n

/** Yield vault (9k staked, 1k liquid) with a VaultOrderExecutor in front of the real reactor. */
export async function deployExecutorContext(): Promise<ExecutorContext> {
  const ctx = await deployOperatorVault({
    realUniswapX: true,
    enableYield: true,
    minLiquidSettlement: usdt(1_000n),
  })
  const Executor = await ethers.getContractFactory('VaultOrderExecutor')
  const executor = await Executor.deploy(
    ctx.reactor,
    await ctx.factory.getAddress()
  )
  await seedShares(ctx, ctx.lp1, usdt(10_000n))
  await ctx.vault.allocateIdle()
  return { ...ctx, executor }
}

export async function signedExecutorOrder(
  ctx: ExecutorContext,
  o: {
    inputToken: string
    inputAmount: bigint
    outputToken: string
    outputAmount: bigint
    taker: string
    /** Defaults to the real RFQ binding, {taker, executor}: fill() only
     *  lets a bound filler call it, and the reactor sees the executor. */
    fillers?: string[]
  }
) {
  const [block, epoch, executorAddr] = await Promise.all([
    ethers.provider.getBlock('latest'),
    ctx.vault.tradingEpoch(),
    ctx.executor.getAddress(),
  ])
  const { signature, params } = await signVaultEnvelope(
    ctx.strategy,
    ctx.risk,
    {
      reactor: ctx.reactor,
      vault: ctx.vault.target as string,
      permit2: CANONICAL_PERMIT2,
      chainId: 31337,
      nonce: (epoch << 128n) | nonceCounter++,
      deadline: BigInt(block!.timestamp + 600),
      preferredFiller: ctx.preferredFiller,
      fillers: [o.taker, executorAddr],
      ...o,
    }
  )
  return { order: encodeLimitOrder(params), sig: signature }
}
