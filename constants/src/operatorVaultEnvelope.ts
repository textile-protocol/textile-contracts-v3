/**
 * OperatorVault ERC-1271 envelope + NAV attestation types.
 *
 * Mirrors `packages/protocol/contracts/v3/filler/vault/libraries/VaultPolicy.sol`
 * (`abi.decode(signature, (LimitOrder, bytes, bytes))`) and the Hardhat helper
 * in `packages/protocol/test/v3/OperatorVault/helpers/vaultSignatures.ts`.
 * Keep this file and those two in lockstep.
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  type Address,
  type Hex,
} from 'viem'

import {
  normalizeFillerOrderValidation,
  type FillerLimitOrderFields,
} from './fillerLimitOrder'

const ORDER_INFO_COMPONENTS = [
  { name: 'reactor', type: 'address' },
  { name: 'swapper', type: 'address' },
  { name: 'nonce', type: 'uint256' },
  { name: 'deadline', type: 'uint256' },
  { name: 'additionalValidationContract', type: 'address' },
  { name: 'additionalValidationData', type: 'bytes' },
] as const

/** UniswapX LimitOrder ABI tuple — same shape as the reactor `execute` payload. */
export const VAULT_LIMIT_ORDER_TUPLE = {
  type: 'tuple',
  components: [
    { name: 'info', type: 'tuple', components: ORDER_INFO_COMPONENTS },
    {
      name: 'input',
      type: 'tuple',
      components: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'maxAmount', type: 'uint256' },
      ],
    },
    {
      name: 'outputs',
      type: 'tuple[]',
      components: [
        { name: 'token', type: 'address' },
        { name: 'amount', type: 'uint256' },
        { name: 'recipient', type: 'address' },
      ],
    },
  ],
} as const

const VAULT_ENVELOPE_PARAMS = [
  VAULT_LIMIT_ORDER_TUPLE,
  { type: 'bytes' },
  { type: 'bytes' },
] as const

export interface NavAttestation {
  vault: Address
  chainId: bigint
  epochId: bigint
  corridorAssetPrice: bigint
  nav: bigint
  lastSettledNav: bigint
  freeSettlement: bigint
  freeCorridor: bigint
  validAfter: bigint
  validUntil: bigint
}

export interface VaultEnvelope {
  order: FillerLimitOrderFields
  operatorSig: Hex
  riskSig: Hex
}

function toEncodedOrder(order: FillerLimitOrderFields) {
  const validation = normalizeFillerOrderValidation(order)
  return {
    info: {
      reactor: order.reactor,
      swapper: order.swapper,
      nonce: order.nonce,
      deadline: order.deadline,
      additionalValidationContract: validation.additionalValidationContract,
      additionalValidationData: validation.additionalValidationData,
    },
    input: {
      token: order.inputToken,
      amount: order.inputAmount,
      maxAmount: order.inputAmount,
    },
    outputs: [
      {
        token: order.outputToken,
        amount: order.outputAmount,
        recipient: order.recipient,
      },
    ],
  }
}

function fromEncodedOrder(order: {
  info: {
    reactor: Address
    swapper: Address
    nonce: bigint
    deadline: bigint
    additionalValidationContract: Address
    additionalValidationData: Hex
  }
  input: { token: Address; amount: bigint }
  outputs: readonly { token: Address; amount: bigint; recipient: Address }[]
}): FillerLimitOrderFields {
  if (order.outputs.length !== 1) {
    throw new Error('Expected single-output vault envelope')
  }
  const output = order.outputs[0]
  return {
    reactor: getAddress(order.info.reactor),
    swapper: getAddress(order.info.swapper),
    nonce: order.info.nonce,
    deadline: order.info.deadline,
    inputToken: getAddress(order.input.token),
    inputAmount: order.input.amount,
    outputToken: getAddress(output.token),
    outputAmount: output.amount,
    recipient: getAddress(output.recipient),
    additionalValidationContract: getAddress(
      order.info.additionalValidationContract
    ),
    additionalValidationData: order.info.additionalValidationData,
  }
}

/** `abi.encode(LimitOrder, operatorSig, riskSig)` — ERC-1271 payload the vault checks. */
export function encodeVaultEnvelope(
  order: FillerLimitOrderFields,
  operatorSig: Hex,
  riskSig: Hex
): Hex {
  return encodeAbiParameters(VAULT_ENVELOPE_PARAMS, [
    toEncodedOrder(order),
    operatorSig,
    riskSig,
  ])
}

export function decodeVaultEnvelope(encoded: Hex): VaultEnvelope {
  const [order, operatorSig, riskSig] = decodeAbiParameters(
    VAULT_ENVELOPE_PARAMS,
    encoded
  )
  return {
    order: fromEncodedOrder(order),
    operatorSig,
    riskSig,
  }
}
