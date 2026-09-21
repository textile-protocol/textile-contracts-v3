import { expect } from 'chai'

import {
  YEAR,
  convertToAssets,
  convertToShares,
  epochFromNonce,
  feeShares,
  splitFee,
  performanceFeeShares,
  chargeableGain,
  perShareTotal,
  basketPerShare,
  markAfter,
  wadToPercent,
  nav,
  proRataWithResidue,
  quotable,
  tradingNonce,
  MAX_FEE_ACCRUAL_WAD,
  WAD,
} from '../../../constants/src/operatorVaultMath'

describe('operatorVaultMath (TS reference)', function () {
  it('covers every helper branch', function () {
    expect(convertToShares(0n, 0n, 0n)).to.equal(0n)
    expect(convertToAssets(100n, 100n, 100n)).to.equal(100n)
    expect(nav(10n, 0n, WAD, 18, 18)).to.equal(10n)
    expect(nav(0n, 10n ** 18n, WAD, 6, 18)).to.equal(1_000_000n)
    expect(nav(10n, 2n, WAD, 18, 6)).to.equal(10n + 2n * 10n ** 12n)
    expect(quotable(5n, 5n)).to.equal(0n)
    expect(quotable(4n, 5n)).to.equal(0n)
    expect(quotable(9n, 5n)).to.equal(4n)
    expect(splitFee(1009n, 10n ** 17n)).to.deep.equal({
      operatorShares: 909n,
      protocolShares: 100n,
    })
    expect(splitFee(9n, 10n ** 17n)).to.deep.equal({ operatorShares: 9n, protocolShares: 0n })
    expect(feeShares(0n, 1n, 1n)).to.equal(0n)
    expect(feeShares(1n, 0n, 1n)).to.equal(0n)
    expect(feeShares(1n, 1n, 0n)).to.equal(0n)
    expect(feeShares(900n, WAD / 10n, YEAR)).to.equal(100n)
    // f >= 1 clamps, minting one share per share outstanding.
    expect(feeShares(YEAR, WAD, YEAR)).to.equal(YEAR)
    expect(feeShares(1000n, WAD * 3n, YEAR)).to.equal(1000n)
    expect(epochFromNonce(tradingNonce(3n, 5n))).to.equal(3n)
    expect(proRataWithResidue(0n, 1n, 10n)).to.equal(0n)
    expect(proRataWithResidue(1n, 0n, 10n)).to.equal(0n)
    expect(proRataWithResidue(2n, 2n, 7n)).to.equal(7n)
    expect(proRataWithResidue(1n, 2n, 7n)).to.equal(3n)
  })

  it('dilutes LPs by exactly the nominal management rate', function () {
    const supply = 1_000_000n * WAD
    for (const [feeWad, elapsed, expectedWad] of [
      [WAD / 50n, YEAR, WAD / 50n],
      [WAD / 100n, YEAR, WAD / 100n],
      [WAD / 4n, YEAR, WAD / 4n],
      [WAD / 50n, YEAR / 2n, WAD / 100n],
      [WAD / 50n, YEAR * 5n, WAD / 10n],
    ] as const) {
      const minted = feeShares(supply, feeWad, elapsed)
      const slice = (minted * WAD) / (supply + minted)
      // The mint floors, so the slice lands at or just under the rate.
      expect(slice).to.be.gte(expectedWad - 1n)
      expect(slice).to.be.lte(expectedWad)
    }
  })

  it('never mints more than the accrual clamp allows', function () {
    const supply = 1_000_000n * WAD
    for (const elapsed of [YEAR * 4n, YEAR * 40n, YEAR * 400n]) {
      const minted = feeShares(supply, WAD / 4n, elapsed)
      const slice = (minted * WAD) / (supply + minted)
      expect(slice).to.equal(MAX_FEE_ACCRUAL_WAD)
    }
  })

  it('covers the performance-fee branches', function () {
    // Off, or nothing to charge.
    expect(performanceFeeShares(100n, 0n, 10n, WAD / 5n)).to.equal(0n)
    expect(performanceFeeShares(100n, 100n, 10n, 0n)).to.equal(0n)
    expect(performanceFeeShares(100n, 100n, 0n, WAD / 5n)).to.equal(0n)
    // A gain too small to round into a fee.
    expect(performanceFeeShares(101n, 100n, 1n, WAD / 1000n)).to.equal(0n)

    // 20% of a 10% gain, minted against post-fee NAV so the holder keeps 80%
    // of it rather than 80%/(1+20%).
    const supply = 1_000_000n * WAD
    const navAssets = 1_100_000n * WAD
    const minted = performanceFeeShares(navAssets, supply, 100_000n * WAD, WAD / 5n)
    const holderValue = (supply * navAssets) / (supply + minted)
    expect(holderValue).to.be.closeTo(1_080_000n * WAD, WAD)
  })

  it('charges the smaller of the two gains, and nothing under either mark', function () {
    expect(chargeableGain(100n, 100n, 90n)).to.equal(0n) // at the basket
    expect(chargeableGain(100n, 90n, 100n)).to.equal(0n) // at the absolute mark
    expect(chargeableGain(100n, 110n, 90n)).to.equal(0n) // under the basket
    expect(chargeableGain(100n, 90n, 95n)).to.equal(5n) // the floor binds
    expect(chargeableGain(100n, 95n, 90n)).to.equal(5n) // the basket binds
    expect(chargeableGain(100n, 90n, 90n)).to.equal(10n)
  })

  it('scales a basket leg between per-share and total form', function () {
    expect(perShareTotal(WAD / 2n, 1_000n)).to.equal(500n)
    expect(basketPerShare(500n, 1_000n)).to.equal(WAD / 2n)
    expect(basketPerShare(500n, 0n)).to.equal(0n)
    // Rounds up, so scaling back out never lands under what was written.
    expect(basketPerShare(1n, 3n)).to.equal(WAD / 3n + 1n)
  })

  it('covers the mark branches', function () {
    // The mark ratchets up and never down: that is the high-water property.
    expect(markAfter(200n, 100n, WAD)).to.equal(2n * WAD)
    expect(markAfter(50n, 100n, WAD)).to.equal(WAD)
    // An empty vault re-bases to par rather than carrying an old bar.
    expect(markAfter(50n, 0n, 2n * WAD)).to.equal(WAD)
  })

  it('formats a WAD fraction as a percent', function () {
    expect(wadToPercent(WAD / 10n)).to.equal(10)
    expect(wadToPercent(0n)).to.equal(0)
    expect(wadToPercent(WAD / 8n)).to.equal(12.5)
  })
})
