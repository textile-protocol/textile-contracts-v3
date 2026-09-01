import { expect } from 'chai'

import {
  YEAR,
  convertToAssets,
  convertToShares,
  epochFromNonce,
  feeShares,
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
})
