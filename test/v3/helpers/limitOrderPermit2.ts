/**
 * UniswapX LimitOrder Permit2 witness digest + abi-encoded order, for tests.
 *
 * Viem mirror of `api/src/services/fillerOrders/permit2Order.ts` (itself ported
 * byte-for-byte from the vendored Solidity + cross-checked against the Rust
 * bot). Kept here so the protocol Hardhat tests can sign a real operator order
 * without importing across packages. If the order encoding ever changes, update
 * both.
 */
import {
  concat,
  encodeAbiParameters,
  keccak256,
  toBytes,
  type Address,
  type Hex,
} from 'viem'

export interface LimitOrderParams {
  reactor: Address
  swapper: Address
  nonce: bigint
  deadline: bigint
  inputToken: Address // debt (e.g. USDT) the operator pays
  inputAmount: bigint
  outputToken: Address // collateral (e.g. cNGN) the operator buys
  outputAmount: bigint
  recipient: Address
  additionalValidationContract?: Address
  additionalValidationData?: Hex
}

const ZERO: Address = '0x0000000000000000000000000000000000000000'

const ORDER_INFO_TYPE =
  'OrderInfo(address reactor,address swapper,uint256 nonce,uint256 deadline,address additionalValidationContract,bytes additionalValidationData)'
const OUTPUT_TOKEN_TYPE =
  'OutputToken(address token,uint256 amount,address recipient)'
const LIMIT_ORDER_HEAD =
  'LimitOrder(OrderInfo info,address inputToken,uint256 inputAmount,OutputToken[] outputs)'
const TOKEN_PERMISSIONS_TYPE = 'TokenPermissions(address token,uint256 amount)'
const PERMIT_WITNESS_STUB =
  'PermitWitnessTransferFrom(TokenPermissions permitted,address spender,uint256 nonce,uint256 deadline,'
const WITNESS_KEYWORD = 'LimitOrder witness)'
const EIP712_DOMAIN_TYPE =
  'EIP712Domain(string name,uint256 chainId,address verifyingContract)'

const k = (s: string): Hex => keccak256(toBytes(s))

const ORDER_TYPE_HASH = k(LIMIT_ORDER_HEAD + ORDER_INFO_TYPE + OUTPUT_TOKEN_TYPE)
const PERMIT2_WITNESS_TYPE_HASH = k(
  PERMIT_WITNESS_STUB +
    WITNESS_KEYWORD +
    LIMIT_ORDER_HEAD +
    ORDER_INFO_TYPE +
    OUTPUT_TOKEN_TYPE +
    TOKEN_PERMISSIONS_TYPE
)
const ORDER_INFO_TYPE_HASH = k(ORDER_INFO_TYPE)
const OUTPUT_TOKEN_TYPE_HASH = k(OUTPUT_TOKEN_TYPE)
const TOKEN_PERMISSIONS_TYPE_HASH = k(TOKEN_PERMISSIONS_TYPE)
const EIP712_DOMAIN_TYPE_HASH = k(EIP712_DOMAIN_TYPE)
const PERMIT2_NAME_HASH = k('Permit2')
const EMPTY_BYTES_HASH = keccak256('0x')

const b32 = { type: 'bytes32' } as const
const addr = { type: 'address' } as const
const u256 = { type: 'uint256' } as const

function orderInfoHash(o: LimitOrderParams): Hex {
  const validationContract = o.additionalValidationContract ?? ZERO
  const validationData = o.additionalValidationData ?? '0x'
  return keccak256(
    encodeAbiParameters(
      [b32, addr, addr, u256, u256, addr, b32],
      [
        ORDER_INFO_TYPE_HASH,
        o.reactor,
        o.swapper,
        o.nonce,
        o.deadline,
        validationContract,
        validationData === '0x' ? EMPTY_BYTES_HASH : keccak256(validationData),
      ]
    )
  )
}

function outputsHash(o: LimitOrderParams): Hex {
  const one = keccak256(
    encodeAbiParameters(
      [b32, addr, u256, addr],
      [OUTPUT_TOKEN_TYPE_HASH, o.outputToken, o.outputAmount, o.recipient]
    )
  )
  return keccak256(one)
}

function limitOrderHash(o: LimitOrderParams): Hex {
  return keccak256(
    encodeAbiParameters(
      [b32, b32, addr, u256, b32],
      [ORDER_TYPE_HASH, orderInfoHash(o), o.inputToken, o.inputAmount, outputsHash(o)]
    )
  )
}

function permitStructHash(o: LimitOrderParams): Hex {
  const tokenPermissions = keccak256(
    encodeAbiParameters(
      [b32, addr, u256],
      [TOKEN_PERMISSIONS_TYPE_HASH, o.inputToken, o.inputAmount]
    )
  )
  return keccak256(
    encodeAbiParameters(
      [b32, b32, addr, u256, u256, b32],
      [PERMIT2_WITNESS_TYPE_HASH, tokenPermissions, o.reactor, o.nonce, o.deadline, limitOrderHash(o)]
    )
  )
}

/** EIP-712 digest the operator signs (`0x1901 ++ domain ++ structHash`). */
export function permit2Digest(o: LimitOrderParams, permit2: Address, chainId: number): Hex {
  const domain = keccak256(
    encodeAbiParameters(
      [b32, b32, u256, addr],
      [EIP712_DOMAIN_TYPE_HASH, PERMIT2_NAME_HASH, BigInt(chainId), permit2]
    )
  )
  return keccak256(concat(['0x1901', domain, permitStructHash(o)]))
}

const LIMIT_ORDER_TUPLE = {
  type: 'tuple',
  components: [
    {
      name: 'info',
      type: 'tuple',
      components: [
        { name: 'reactor', type: 'address' },
        { name: 'swapper', type: 'address' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
        { name: 'additionalValidationContract', type: 'address' },
        { name: 'additionalValidationData', type: 'bytes' },
      ],
    },
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

type Output = { token: Address; amount: bigint; recipient: Address }

/** abi.encode(LimitOrder) with an explicit outputs array. */
export function encodeLimitOrderWithOutputs(
  o: LimitOrderParams,
  outputs: Output[]
): Hex {
  const validationContract = o.additionalValidationContract ?? ZERO
  const validationData = o.additionalValidationData ?? '0x'
  return encodeAbiParameters(
    [LIMIT_ORDER_TUPLE],
    [
      {
        info: {
          reactor: o.reactor,
          swapper: o.swapper,
          nonce: o.nonce,
          deadline: o.deadline,
          additionalValidationContract: validationContract,
          additionalValidationData: validationData,
        },
        input: { token: o.inputToken, amount: o.inputAmount, maxAmount: o.inputAmount },
        outputs,
      },
    ]
  )
}

/** abi.encode(LimitOrder) — the `order` bytes for executeBatch. */
export function encodeLimitOrder(o: LimitOrderParams): Hex {
  return encodeLimitOrderWithOutputs(o, [
    { token: o.outputToken, amount: o.outputAmount, recipient: o.recipient },
  ])
}
