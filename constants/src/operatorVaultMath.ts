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
