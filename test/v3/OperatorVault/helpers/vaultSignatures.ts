import { AbiCoder, Wallet } from 'ethers'
import { ethers } from 'hardhat'

import { nav } from '../../../../constants/src/operatorVaultMath'
import type { OperatorVault, VaultLibHarness } from '../../../../typechain-types'
import { permit2Digest, type LimitOrderParams } from '../../helpers/limitOrderPermit2'
import { signDigest } from '../fixtures/operatorVault.fixture'

export interface Attestation {
  vault: string
  chainId: bigint
  epochId: bigint
  corridorAssetPrice: bigint
  lastSettledNav: bigint
  freeSettlement: bigint
  freeCorridor: bigint
  validAfter: bigint
  validUntil: bigint
}

export async function signAttestation(
  harness: VaultLibHarness,
  signer: Wallet,
  att: Attestation
): Promise<string> {
  const digest = await harness.attestationDigest(att, att.vault, att.chainId)
  return signDigest(signer, digest)
}

/** Both signatures the vault takes, in its order: strategy, then risk. */
export async function attestationSignatures(
  ctx: { harness: VaultLibHarness; strategy: Wallet; risk: Wallet },
  att: Attestation
): Promise<[string, string]> {
  const digest = await ctx.harness.attestationDigest(att, att.vault, att.chainId)
  return [signDigest(ctx.strategy, digest), signDigest(ctx.risk, digest)]
}

export async function freshAttestation(
  vault: OperatorVault,
  epochId: bigint,
  price: bigint,
  now?: number
): Promise<Attestation> {
  const t = BigInt(now ?? (await ethers.provider.getBlock('latest'))!.timestamp)
  const [freeSettlement, freeCorridor, lastSettledNav] = await Promise.all([
    vault.freeSettlement(),
    vault.freeCorridor(),
    vault.lastSettledNav(),
  ])
  return {
    vault: await vault.getAddress(),
    chainId: (await ethers.provider.getNetwork()).chainId,
    epochId,
    corridorAssetPrice: price,
    lastSettledNav,
    freeSettlement,
    freeCorridor,
    validAfter: t - 60n,
    validUntil: t + 3600n,
  }
}

/** The NAV the vault derives from an attestation: its floors at its price. */
export async function attestedNav(vault: OperatorVault, att: Attestation): Promise<bigint> {
  const [settlementDecimals, corridorDecimals] = await Promise.all([
    vault.settlementDecimals(),
    vault.corridorDecimals(),
  ])
  return nav(
    att.freeSettlement,
    att.freeCorridor,
    att.corridorAssetPrice,
    Number(settlementDecimals),
    Number(corridorDecimals)
  )
}

export function encodeValidationData(fillers: string[], exclusiveUntil: bigint): string {
  return AbiCoder.defaultAbiCoder().encode(['address[]', 'uint256'], [fillers, exclusiveUntil])
}

export interface VaultOrderInput {
  reactor: string
  vault: string
  permit2: string
  chainId: number
  nonce: bigint
  deadline: bigint
  inputToken: string
  inputAmount: bigint
  outputToken: string
  outputAmount: bigint
  preferredFiller: string
  taker: string
  /** Full preferred-filler list; defaults to `[taker]`. Pass `[taker, executor]`
   *  for an order fillable through the VaultOrderExecutor. */
  fillers?: string[]
  exclusiveUntil?: bigint
  /** Permit2's permitted amount. Defaults to `inputAmount`, which is the only
   *  value the vault's policy accepts; override it to exercise the spread. */
  inputMaxAmount?: bigint
}

export function orderParams(o: VaultOrderInput): LimitOrderParams {
  return {
    reactor: o.reactor as `0x${string}`,
    swapper: o.vault as `0x${string}`,
    nonce: o.nonce,
    deadline: o.deadline,
    inputToken: o.inputToken as `0x${string}`,
    inputAmount: o.inputAmount,
    outputToken: o.outputToken as `0x${string}`,
    outputAmount: o.outputAmount,
    recipient: o.vault as `0x${string}`,
    additionalValidationContract: o.preferredFiller as `0x${string}`,
    additionalValidationData: encodeValidationData(
      o.fillers ?? [o.taker],
      o.exclusiveUntil ?? o.deadline
    ) as `0x${string}`,
  }
}

export async function signVaultEnvelope(
  strategy: Wallet,
  risk: Wallet,
  o: VaultOrderInput
): Promise<{ hash: string; signature: string; params: LimitOrderParams }> {
  const params = orderParams(o)
  const hash = permit2Digest(params, o.permit2 as `0x${string}`, o.chainId)
  const operatorSig = await signDigest(strategy, hash)
  const riskSig = await signDigest(risk, hash)
  const envelope = AbiCoder.defaultAbiCoder().encode(
    [
      'tuple(tuple(address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData) info,tuple(address token,uint256 amount,uint256 maxAmount) input,tuple(address token,uint256 amount,address recipient)[] outputs)',
      'bytes',
      'bytes',
    ],
    [
      {
        info: {
          reactor: params.reactor,
          swapper: params.swapper,
          nonce: params.nonce,
          deadline: params.deadline,
          additionalValidationContract: params.additionalValidationContract,
          additionalValidationData: params.additionalValidationData,
        },
        input: {
          token: params.inputToken,
          amount: params.inputAmount,
          // Not covered by the witness or by `VaultLib.permit2Digest`, so an
          // override here leaves `hash` alone and lands on the order policy.
          maxAmount: o.inputMaxAmount ?? params.inputAmount,
        },
        outputs: [
          {
            token: params.outputToken,
            amount: params.outputAmount,
            recipient: params.recipient,
          },
        ],
      },
      operatorSig,
      riskSig,
    ]
  )
  return { hash, signature: envelope, params }
}

/**
 * A policy-valid settlement→corridor order for `ctx`, ready for
 * `signVaultEnvelope`. Tests override the field they are exercising.
 */
export async function defaultOrder(
  ctx: {
    reactor: string
    permit2: string
    preferredFiller: string
    vault: { target: string | object }
    settlement: { target: string | object }
    corridor: { target: string | object }
    other: { address: string }
  },
  overrides: Partial<VaultOrderInput> = {}
): Promise<VaultOrderInput> {
  const chainId = Number((await ethers.provider.getNetwork()).chainId)
  const now = (await ethers.provider.getBlock('latest'))!.timestamp
  return {
    reactor: ctx.reactor,
    vault: ctx.vault.target as string,
    permit2: ctx.permit2,
    chainId,
    nonce: 1n << 128n,
    deadline: BigInt(now + 600),
    inputToken: ctx.settlement.target as string,
    inputAmount: 100n * 10n ** 6n,
    outputToken: ctx.corridor.target as string,
    outputAmount: 100n * 10n ** 18n,
    preferredFiller: ctx.preferredFiller,
    taker: ctx.other.address,
    ...overrides,
  }
}
