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
    const exp = BigInt(settlementDecimals - corridorDecimals)
    return freeSettlement + mulDiv(freeCorridor, priceWad, WAD / 10n ** exp)
  }
  const scale = 10n ** BigInt(corridorDecimals - settlementDecimals)
  return freeSettlement + mulDiv(freeCorridor, priceWad, scale * WAD)
}

export function quotable(freeBalance: bigint, minReserve: bigint): bigint {
  if (freeBalance <= minReserve) return 0n
  return freeBalance - minReserve
}

export function feeShares(
  supply: bigint,
  feeWad: bigint,
  elapsed: bigint
): bigint {
  if (supply === 0n || feeWad === 0n || elapsed === 0n) return 0n
  return mulDiv(supply, feeWad * elapsed, WAD * YEAR)
}

/** VaultPolicy.MAX_MANAGEMENT_FEE_WAD: 25% of supply per year. */
export const MAX_MANAGEMENT_FEE_WAD = WAD / 4n

/**
 * VaultPolicy.MAX_PERFORMANCE_FEE_WAD: 50% of the gain above the mark. Also a
 * safety bound — `performanceFeeShares` divides by `nav - feeAssets`.
 */
export const MAX_PERFORMANCE_FEE_WAD = WAD / 2n

/**
 * Protocol cut of every operator-vault fee accrual, management and
 * performance alike, as a WAD fraction of the shares minted. Every
 * OperatorVaultFactory Textile deploys is constructed with this value
 * (deploy-operator-vault-factory.ts reads it), and each vault reads it back
 * from its factory at checkpoint. The on-chain immutable is the source of
 * truth; this is what the deploy script writes and what the UI previews
 * before a factory answers.
 */
export const OPERATOR_VAULT_PROTOCOL_FEE_SHARE_WAD = WAD / 10n

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

/**
 * Mirrors VaultLib.performanceFeeShares. Shares to mint for `feeWad` of the
 * NAV sitting above `markWad`, minted against post-fee NAV so holders keep
 * exactly `1 - feeWad` of the gain.
 */
export function performanceFeeShares(
  navAssets: bigint,
  supply: bigint,
  markWad: bigint,
  feeWad: bigint
): bigint {
  if (supply === 0n || feeWad === 0n) return 0n
  const mark = mulDiv(markWad, supply, WAD)
  if (navAssets <= mark) return 0n
  const feeAssets = mulDiv(navAssets - mark, feeWad, WAD)
  if (feeAssets === 0n) return 0n
  return mulDiv(feeAssets, supply, navAssets - feeAssets)
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

/** Mirrors OperatorVaultFactory.VERSION: the VaultInit layout the admin form and deploy script encode. */
export const OPERATOR_VAULT_FACTORY_VERSION = 2

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
