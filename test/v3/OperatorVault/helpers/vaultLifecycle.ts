import { time } from '@nomicfoundation/hardhat-network-helpers'
import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'

import { DAY, PRICE_1, usdt, type DeployedVault } from '../fixtures/operatorVault.fixture'
import { freshAttestation, signAttestation } from './vaultSignatures'

export async function closeAndProcessDeposit(
  ctx: DeployedVault,
  epochId?: bigint,
  price: bigint = PRICE_1
): Promise<bigint> {
  const id = epochId ?? (await ctx.vault.currentDepositEpochId())
  await time.increase(DAY)
  await ctx.vault.closeDepositEpoch(id)
  const att = await freshAttestation(ctx.vault, id, price)
  const sig = await signAttestation(ctx.harness, ctx.risk, att)
  await ctx.vault.processDepositEpoch(id, att, sig)
  return id
}

export async function seedShares(
  ctx: DeployedVault,
  owner: SignerWithAddress,
  amount: bigint = usdt(1_000n)
): Promise<{ depositId: bigint; amount: bigint }> {
  await ctx.vault.connect(owner).requestDeposit(amount, owner.address, owner.address)
  const depositId = await closeAndProcessDeposit(ctx)
  await ctx.vault.connect(owner).claim(depositId, owner.address, owner.address)
  return { depositId, amount }
}

export async function closeRedeem(ctx: DeployedVault, epochId?: bigint): Promise<bigint> {
  const id = epochId ?? (await ctx.vault.currentRedeemEpochId())
  await time.increase(DAY)
  await ctx.vault.closeRedeemEpoch(id)
  return id
}

export async function closeAndSettleRedeem(
  ctx: DeployedVault,
  epochId?: bigint,
  price: bigint = PRICE_1
): Promise<bigint> {
  const id = await closeRedeem(ctx, epochId)
  const att = await freshAttestation(ctx.vault, id, price)
  const sig = await signAttestation(ctx.harness, ctx.risk, att)
  await ctx.vault.settleRedeemEpoch(id, att, sig)
  return id
}
