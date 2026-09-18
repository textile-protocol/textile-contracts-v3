import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { time } from '@nomicfoundation/hardhat-network-helpers'
import { ethers } from 'hardhat'

import type { ERC20Mock } from '../../../../typechain-types'
import {
  DAY,
  PRICE_1,
  usdt,
  type DeployedVault,
} from '../fixtures/operatorVault.fixture'

import { freshAttestation, attestationSignatures } from './vaultSignatures'

export async function closeDeposit(
  ctx: DeployedVault,
  epochId?: bigint
): Promise<bigint> {
  const id = epochId ?? (await ctx.vault.currentDepositEpochId())
  await time.increase(DAY)
  await ctx.vault.closeDepositEpoch(id)
  return id
}

/** Process a closed deposit epoch with a fresh attestation of the live
 *  balances. Returns the NAV the signer attested. */
export async function processDeposit(
  ctx: DeployedVault,
  epochId: bigint,
  price: bigint = PRICE_1
): Promise<bigint> {
  const att = await freshAttestation(ctx.vault, epochId, price)
  const sigs = await attestationSignatures(ctx, att)
  await ctx.vault.processDepositEpoch(epochId, att, ...sigs)
  return att.nav
}

export async function closeAndProcessDeposit(
  ctx: DeployedVault,
  epochId?: bigint,
  price: bigint = PRICE_1
): Promise<bigint> {
  const id = await closeDeposit(ctx, epochId)
  await processDeposit(ctx, id, price)
  return id
}

export async function seedShares(
  ctx: DeployedVault,
  owner: SignerWithAddress,
  amount: bigint = usdt(1_000n)
): Promise<{ depositId: bigint; amount: bigint }> {
  await ctx.vault
    .connect(owner)
    .requestDeposit(amount, owner.address, owner.address)
  const depositId = await closeAndProcessDeposit(ctx)
  await ctx.vault.connect(owner).claim(depositId, owner.address, owner.address)
  return { depositId, amount }
}

/** Guardian pause, then wait out `emergencyExitTimeout`. */
export async function armEmergencyExit(ctx: DeployedVault): Promise<void> {
  await ctx.vault.connect(ctx.guardian).pause()
  await time.increase(await ctx.vault.emergencyExitTimeout())
}

export async function closeRedeem(
  ctx: DeployedVault,
  epochId?: bigint
): Promise<bigint> {
  const id = epochId ?? (await ctx.vault.currentRedeemEpochId())
  await time.increase(DAY)
  // The operator closes on its own schedule; a third party would also have
  // to wait out `valuationTimeout` (audit v0.2 L-02) — see `closeRedeemAsAnyone`.
  await ctx.vault.connect(ctx.operatorAdmin).closeRedeemEpoch(id)
  return id
}

/** The backstop path: nobody with an operator key shows up, and a third
 *  party closes once `redemptionEpochDuration + valuationTimeout` has run. */
export async function closeRedeemAsAnyone(ctx: DeployedVault, epochId?: bigint): Promise<bigint> {
  const id = epochId ?? (await ctx.vault.currentRedeemEpochId())
  await time.increase((await ctx.vault.redemptionEpochDuration()) + (await ctx.vault.valuationTimeout()))
  await ctx.vault.connect(ctx.other).closeRedeemEpoch(id)
  return id
}

export async function closeAndSettleRedeem(
  ctx: DeployedVault,
  epochId?: bigint,
  price: bigint = PRICE_1
): Promise<bigint> {
  const id = await closeRedeem(ctx, epochId)
  const att = await freshAttestation(ctx.vault, id, price)
  const sigs = await attestationSignatures(ctx, att)
  await ctx.vault.settleRedeemEpoch(id, att, ...sigs)
  return id
}

/** Move tokens straight out of the vault, as a mid-fill Permit2 pull would. */
export async function pullFromVault(
  ctx: DeployedVault,
  token: ERC20Mock,
  to: string,
  amount: bigint
): Promise<void> {
  const vaultAddr = await ctx.vault.getAddress()
  await ethers.provider.send('hardhat_impersonateAccount', [vaultAddr])
  await ethers.provider.send('hardhat_setBalance', [
    vaultAddr,
    '0x1000000000000000000',
  ])
  const asVault = await ethers.getSigner(vaultAddr)
  await token.connect(asVault).transfer(to, amount)
}
