import { expect } from 'chai'

import {
  YEAR,
  convertToAssets,
  convertToShares,
  epochFromNonce,
  feeShares,
  splitFee,
  performanceFeeShares,
  markAfter,
  wadToPercent,
  nav,
  proRataWithResidue,
  quotable,
  tradingNonce,
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
    expect(feeShares(YEAR, WAD, YEAR)).to.equal(YEAR)
    expect(epochFromNonce(tradingNonce(3n, 5n))).to.equal(3n)
    expect(proRataWithResidue(0n, 1n, 10n)).to.equal(0n)
    expect(proRataWithResidue(1n, 0n, 10n)).to.equal(0n)
    expect(proRataWithResidue(2n, 2n, 7n)).to.equal(7n)
    expect(proRataWithResidue(1n, 2n, 7n)).to.equal(3n)
  })

  it('covers the performance-fee branches', function () {
    // Off, or nothing outstanding to charge.
    expect(performanceFeeShares(100n, 0n, WAD, WAD / 5n)).to.equal(0n)
    expect(performanceFeeShares(100n, 100n, WAD, 0n)).to.equal(0n)
    // At or under the mark.
    expect(performanceFeeShares(100n, 100n, WAD, WAD / 5n)).to.equal(0n)
    expect(performanceFeeShares(99n, 100n, WAD, WAD / 5n)).to.equal(0n)
    // A gain too small to round into a fee.
    expect(performanceFeeShares(101n, 100n, WAD, WAD / 1000n)).to.equal(0n)

    // 20% of a 10% gain, minted against post-fee NAV so the holder keeps 80%
    // of it rather than 80%/(1+20%).
    const supply = 1_000_000n * WAD
    const navAssets = 1_100_000n * WAD
    const minted = performanceFeeShares(navAssets, supply, WAD, WAD / 5n)
    const holderValue = (supply * navAssets) / (supply + minted)
    expect(holderValue).to.be.closeTo(1_080_000n * WAD, WAD)
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
