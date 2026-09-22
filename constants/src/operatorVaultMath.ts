/**
 * OperatorVault share / NAV / fee math.
 *
 * Mirrors `packages/protocol/contracts/v3/filler/vault/libraries/VaultLib.sol`.
 * Keep this file and the Solidity library in lockstep.
 */

// Not `10n ** 18n`: babel-jest (web tests) compiles bigint `**` to Math.pow,
// which throws on BigInt at module load.
export const WAD = BigInt('1000000000000000000')
export const YEAR = 365n * 24n * 60n * 60n
export const EPOCH_NONCE_SHIFT = 128n

const mulDiv = (a: bigint, b: bigint, c: bigint): bigint => (a * b) / c
// Local rather than feeMath's: this file ships alone in the public contracts export.
const mulDivCeil = (a: bigint, b: bigint, c: bigint): bigint =>
  (a * b + c - 1n) / c

/**
 * 10^n as a bigint, built from a string for the same reason `WAD` is: under
 * babel-jest a bigint `**` becomes `Math.pow`, which throws on BigInt. That
 * used to be a load-time hazard only — `WAD` is a module constant — but
 * `nav()` reaches for a power at *call* time whenever the two assets have
 * different decimals, so every web caller of it (the redeem preview, any
 * test that exercises one) hit `Cannot convert a BigInt value to a number`.
 */
const pow10 = (n: number): bigint => BigInt('1'.padEnd(n + 1, '0'))

export function convertToShares(
  assets: bigint,
  supply: bigint,
  totalAssets: bigint
): bigint {
  return mulDiv(assets, supply + 1n, totalAssets + 1n)
}

export function convertToAssets(
  shares: bigint,
  supply: bigint,
  totalAssets: bigint
): bigint {
  return mulDiv(shares, totalAssets + 1n, supply + 1n)
}

/**
 * Settlement-denominated NAV. `priceWad` is WAD-scaled settlement tokens per
 * one corridor token (1e18 = 1.0).
 */
export function nav(
  freeSettlement: bigint,
  freeCorridor: bigint,
  priceWad: bigint,
  settlementDecimals: number,
  corridorDecimals: number
): bigint {
  if (freeCorridor === 0n || priceWad === 0n) return freeSettlement
  if (settlementDecimals >= corridorDecimals) {
    const exp = settlementDecimals - corridorDecimals
    return freeSettlement + mulDiv(freeCorridor, priceWad, WAD / pow10(exp))
  }
  const scale = pow10(corridorDecimals - settlementDecimals)
  return freeSettlement + mulDiv(freeCorridor, priceWad, scale * WAD)
}

export function quotable(freeBalance: bigint, minReserve: bigint): bigint {
  if (freeBalance <= minReserve) return 0n
  return freeBalance - minReserve
}

/** VaultLib.MAX_FEE_ACCRUAL_WAD: most one fee checkpoint may dilute. */
export const MAX_FEE_ACCRUAL_WAD = WAD / 2n

/**
 * Mirrors VaultLib.feeShares. Grossed up by `1 - f` so the dilution is exactly
 * `f`, not `f / (1 + f)`, and clamped to keep the denominator positive.
 */
export function feeShares(
  supply: bigint,
  feeWad: bigint,
  elapsed: bigint
): bigint {
  if (supply === 0n || feeWad === 0n || elapsed === 0n) return 0n
  const ceiling = MAX_FEE_ACCRUAL_WAD * YEAR
  const accrual = feeWad * elapsed
  const capped = accrual > ceiling ? ceiling : accrual
  return mulDiv(supply, capped, WAD * YEAR - capped)
}

/**
 * VaultPolicy.MAX_MANAGEMENT_FEE_WAD: 25% of supply per year. A ceiling on an
 * immutable the operator sets once, not a suggested rate — the create form's
 * house terms are 10%. Settled at 25% in audit v0.3 N-11.
 */
export const MAX_MANAGEMENT_FEE_WAD = WAD / 4n

/**
 * VaultPolicy.MAX_PERFORMANCE_FEE_WAD: 50% of the gain above the mark. Also a
 * safety bound — `performanceFeeShares` divides by `nav - feeAssets`.
 */
export const MAX_PERFORMANCE_FEE_WAD = WAD / 2n

/**
 * Default Textile cut of an operator-vault fee leg, as a WAD fraction of the
 * shares minted. The cut is set per vault at deploy (one for the management
 * fee, one for the performance fee) and held on the factory; this is only
 * what the admin form and the CLI example start from.
 */
export const OPERATOR_VAULT_PROTOCOL_FEE_SHARE_WAD = WAD / 10n

/** OperatorVaultFactory.MAX_PROTOCOL_FEE_SHARE_WAD: at most half of either fee leg. */
export const MAX_PROTOCOL_FEE_SHARE_WAD = WAD / 2n

/** WAD fraction → percent with up to two decimals (0.1e18 → 10). */
export const wadToPercent = (wad: bigint): number =>
  Number((wad * 10_000n) / WAD) / 100

/**
 * Mirrors VaultLib.splitFee: one accrual of `shares` divided between the
 * operator's fee recipient and the protocol. The protocol leg rounds down and
 * the operator keeps the dust, so the two always sum to `shares`.
 */
export function splitFee(
  shares: bigint,
  protocolShareWad: bigint
): { operatorShares: bigint; protocolShares: bigint } {
  const protocolShares = mulDiv(shares, protocolShareWad, WAD)
  return { operatorShares: shares - protocolShares, protocolShares }
}

/** Mirrors `VaultTypes.BasketMark`: WAD-scaled atomic units of each asset per share. */
export interface BasketMark {
  settlementWad: bigint
  corridorWad: bigint
}

/** Mirrors VaultLib.chargeableGain: NAV above the higher of the two marks. */
export function chargeableGain(
  navNow: bigint,
  basketValue: bigint,
  absValue: bigint
): bigint {
  const bar = basketValue > absValue ? basketValue : absValue
  return navNow > bar ? navNow - bar : 0n
}

/** Mirrors VaultLib.performanceFeeShares: `feeWad` of `gain`, minted against post-fee NAV. */
export function performanceFeeShares(
  navAssets: bigint,
  supply: bigint,
  gain: bigint,
  feeWad: bigint
): bigint {
  if (supply === 0n || feeWad === 0n || gain === 0n) return 0n
  const feeAssets = mulDiv(gain, feeWad, WAD)
  if (feeAssets === 0n) return 0n
  return mulDiv(feeAssets, supply, navAssets - feeAssets)
}

/** Mirrors VaultLib.perShareTotal: a per-share WAD figure scaled out to `supply` shares. */
export function perShareTotal(perShareWad: bigint, supply: bigint): bigint {
  return mulDiv(perShareWad, supply, WAD)
}

/** Mirrors VaultLib.basketPerShare: `units` per share, WAD-scaled and rounded up. */
export function basketPerShare(units: bigint, supply: bigint): bigint {
  if (supply === 0n) return 0n
  return mulDivCeil(units, WAD, supply)
}

/**
 * Mirrors VaultLib.markAfter. The mark only ever ratchets up: a loss leaves it
 * where it was, so the same gain is never charged for twice. An empty vault
 * re-bases to par.
 */
export function markAfter(
  navAssets: bigint,
  supply: bigint,
  markWad: bigint
): bigint {
  if (supply === 0n) return WAD
  const pps = mulDiv(navAssets, WAD, supply)
  return pps > markWad ? pps : markWad
}

/**
 * Mirrors OperatorVaultFactory.VERSION: the VaultInit layout the admin form and
 * deploy script encode, and the vault ABI the keeper drives. Bump both together
 * whenever either changes.
 */
export const OPERATOR_VAULT_FACTORY_VERSION = 1

export function tradingNonce(epoch: bigint, counter: bigint): bigint {
  return (epoch << EPOCH_NONCE_SHIFT) | counter
}

export function epochFromNonce(nonce: bigint): bigint {
  return nonce >> EPOCH_NONCE_SHIFT
}

export function proRataWithResidue(
  claimUnits: bigint,
  remainingUnits: bigint,
  remainingOut: bigint
): bigint {
  if (claimUnits === 0n || remainingUnits === 0n) return 0n
  if (claimUnits === remainingUnits) return remainingOut
  return mulDiv(remainingOut, claimUnits, remainingUnits)
}
