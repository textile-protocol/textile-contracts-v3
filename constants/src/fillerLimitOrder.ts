/**
 * The filler network's signed-order primitive, as EIP-712 typed data.
 *
 * One order shape serves both sides of the book: operator quotes (Stitch) and
 * user limit orders are the same vendored-UniswapX `LimitOrder`, signed as a
 * Permit2 witness. The web signs it with `signTypedData`; the api recovers the
 * signer from the equivalent hand-rolled digest (`permit2Order.ts`); the Rust
 * bot mirrors both (`eip712.rs`). A test in the api package locks this typed
 * data to the api digest so the three can never drift.
 */
import {
  decodeAbiParameters,
  encodeAbiParameters,
  getAddress,
  type Address,
  type Hex,
} from 'viem'

/** Canonical Permit2, same address on every chain we deploy to. */
export const CANONICAL_PERMIT2_ADDRESS: Address =
  '0x000000000022D473030F116dDEE9F6B43aC78BA3'
export const ZERO_ADDRESS: Address =
  '0x0000000000000000000000000000000000000000'
export const MAX_PREFERRED_FILLERS = 10

export interface FillerLimitOrderFields {
  reactor: Address
  /** The wallet that signs and funds the order (the UniswapX swapper). */
  swapper: Address
  nonce: bigint
  /** Unix-seconds expiry — both the Permit2 deadline and the order's. */
  deadline: bigint
  /** Asset the swapper sells. */
  inputToken: Address
  inputAmount: bigint
  /** Asset the swapper receives. */
  outputToken: Address
  outputAmount: bigint
  /** Where the proceeds land (the maker wallet for user limit orders). */
  recipient: Address
  additionalValidationContract?: Address
  additionalValidationData?: Hex
}

/**
 * Field order matches the vendored Solidity type strings verbatim; EIP-712
 * orders referenced struct types alphabetically (LimitOrder, OrderInfo,
 * OutputToken, TokenPermissions), which is exactly how viem's
 * `hashTypedData`/`signTypedData` serialize this object.
 */
export const FILLER_LIMIT_ORDER_TYPES = {
  PermitWitnessTransferFrom: [
    { name: 'permitted', type: 'TokenPermissions' },
    { name: 'spender', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'witness', type: 'LimitOrder' },
  ],
  TokenPermissions: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
  ],
  LimitOrder: [
    { name: 'info', type: 'OrderInfo' },
    { name: 'inputToken', type: 'address' },
    { name: 'inputAmount', type: 'uint256' },
    { name: 'outputs', type: 'OutputToken[]' },
  ],
  OrderInfo: [
    { name: 'reactor', type: 'address' },
    { name: 'swapper', type: 'address' },
    { name: 'nonce', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'additionalValidationContract', type: 'address' },
    { name: 'additionalValidationData', type: 'bytes' },
  ],
  OutputToken: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint256' },
    { name: 'recipient', type: 'address' },
  ],
} as const

export function normalizeFillerOrderValidation(
  order: Pick<
    FillerLimitOrderFields,
    'additionalValidationContract' | 'additionalValidationData'
  >
): {
  additionalValidationContract: Address
  additionalValidationData: Hex
} {
  return {
    additionalValidationContract:
      order.additionalValidationContract ?? ZERO_ADDRESS,
    additionalValidationData: order.additionalValidationData ?? '0x',
  }
}

export function encodePreferredFillerValidationData(
  preferredFillers: Address[],
  exclusiveUntil: bigint
): Hex {
  return encodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint256' }],
    [preferredFillers, exclusiveUntil]
  )
}

export function decodePreferredFillerValidationData(data: Hex): {
  preferredFillers: Address[]
  exclusiveUntil: bigint
} {
  const [preferredFillers, exclusiveUntil] = decodeAbiParameters(
    [{ type: 'address[]' }, { type: 'uint256' }],
    data
  )
  return {
    preferredFillers: preferredFillers.map((address) => getAddress(address)),
    exclusiveUntil,
  }
}

// --- Permit2 unordered nonces ----------------------------------------------
// Permit2 tracks spent nonces in a bitmap: `nonceBitmap[owner][wordPos]` is a
// 256-bit word and a nonce is spent iff its bit is set. Filling an order
// spends its nonce; `invalidateUnorderedNonces(wordPos, mask)` burns bits
// directly, which is how a resting limit order is cancelled trustlessly.

/** Permit2 nonce position: which 256-bit bitmap word, and which bit in it. */
export function permit2NoncePosition(nonce: bigint): {
  wordPos: bigint
  bitPos: bigint
} {
  return { wordPos: nonce >> 8n, bitPos: nonce & 0xffn }
}

/** True when `nonce`'s bit is already set in its Permit2 bitmap word. */
export function permit2NonceSpent(bitmapWord: bigint, nonce: bigint): boolean {
  const { bitPos } = permit2NoncePosition(nonce)
  return ((bitmapWord >> bitPos) & 1n) === 1n
}

/** `invalidateUnorderedNonces` args that burn exactly this nonce. */
export function permit2CancelArgs(nonce: bigint): {
  wordPos: bigint
  mask: bigint
} {
  const { wordPos, bitPos } = permit2NoncePosition(nonce)
  return { wordPos, mask: 1n << bitPos }
}

/**
 * The complete typed-data payload a wallet signs to place a filler limit
 * order. Permit2's domain has no version field; the spender is the reactor,
 * and the permitted amount equals the input amount (a limit order's
 * `maxAmount`).
 */
export function fillerLimitOrderTypedData(
  order: FillerLimitOrderFields,
  permit2: Address,
  chainId: number
) {
  const validation = normalizeFillerOrderValidation(order)
  return {
    domain: {
      name: 'Permit2',
      chainId: BigInt(chainId),
      verifyingContract: permit2,
    },
    types: FILLER_LIMIT_ORDER_TYPES,
    primaryType: 'PermitWitnessTransferFrom',
    message: {
      permitted: { token: order.inputToken, amount: order.inputAmount },
      spender: order.reactor,
      nonce: order.nonce,
      deadline: order.deadline,
      witness: {
        info: {
          reactor: order.reactor,
          swapper: order.swapper,
          nonce: order.nonce,
          deadline: order.deadline,
          additionalValidationContract: validation.additionalValidationContract,
          additionalValidationData: validation.additionalValidationData,
        },
        inputToken: order.inputToken,
        inputAmount: order.inputAmount,
        outputs: [
          {
            token: order.outputToken,
            amount: order.outputAmount,
            recipient: order.recipient,
          },
        ],
      },
    },
  } as const
}
