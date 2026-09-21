import { expect } from 'chai'
import { ethers } from 'hardhat'

import * as math from '../../../constants/src/operatorVaultMath'
import { permit2Digest } from '../helpers/limitOrderPermit2'

import { WAD } from './fixtures/operatorVault.fixture'
import { deployOperatorVault, signDigest } from './fixtures/operatorVault.fixture'

describe('VaultLib', function () {
  it('converts assets to shares with the +1 virtual offset', async function () {
    const { harness } = await deployOperatorVault()
    expect(await harness.convertToShares(1000, 0, 0, false)).to.equal(1000)
    expect(await harness.convertToShares(500, 1000, 1000, false)).to.equal(500)
    expect(await harness.convertToShares(500, 1000, 1000, true)).to.equal(500)
  })

  it('computes NAV and quotable inventory', async function () {
    const { harness } = await deployOperatorVault()
    expect(await harness.nav(1_000_000, 2_000_000, WAD, 18, 18)).to.equal(3_000_000)
    expect(await harness.nav(0, 10n ** 18n, WAD, 6, 18)).to.equal(1_000_000)
    expect(await harness.nav(0, 2n, WAD, 18, 6)).to.equal(2n * 10n ** 12n)
    expect(await harness.quotable(100, 10)).to.equal(90)
    expect(await harness.quotable(10, 10)).to.equal(0)
    expect(await harness.quotable(5, 10)).to.equal(0)
  })

  it('mints no fee shares when supply, rate, or elapsed is zero', async function () {
    const { harness } = await deployOperatorVault()
    expect(await harness.feeShares(0, WAD / 10n, 365 * 24 * 60 * 60)).to.equal(0)
    expect(await harness.feeShares(1000, 0, 365 * 24 * 60 * 60)).to.equal(0)
    expect(await harness.feeShares(1000, WAD / 10n, 0)).to.equal(0)
    // 111 of 1111 is 10% of the vault; 100 of 1100 would be 9.09%.
    expect(await harness.feeShares(1000, WAD / 10n, 365 * 24 * 60 * 60)).to.equal(111)
  })

  it('clamps the accrual so the gross-up denominator stays positive', async function () {
    const { harness } = await deployOperatorVault()
    const year = BigInt(365 * 24 * 60 * 60)
    expect(await harness.feeShares(1000n, WAD, year)).to.equal(1000n)
    expect(await harness.feeShares(1000n, WAD, year * 100n)).to.equal(1000n)
    // Binds at 2 years for the 25% config cap, not before.
    expect(await harness.feeShares(1000n, WAD / 4n, year * 2n)).to.equal(1000n)
    expect(await harness.feeShares(1000n, WAD / 4n, year)).to.equal(333n)
  })

  it('matches the TS reference for the performance fee and the marks', async function () {
    const { harness } = await deployOperatorVault()
    const supply = 1_000_000n * WAD
    const navAssets = 1_100_000n * WAD

    for (const [n, sup, gain, fee] of [
      [navAssets, supply, 100_000n * WAD, WAD / 5n],
      [navAssets, supply, 0n, WAD / 5n], // nothing chargeable
      [navAssets, 0n, 100_000n * WAD, WAD / 5n],
      [navAssets, supply, 100_000n * WAD, 0n],
    ] as const) {
      expect(await harness.performanceFeeShares(n, sup, gain, fee)).to.equal(
        math.performanceFeeShares(n, sup, gain, fee)
      )
    }

    // The smaller of the two gains; nothing at or under either mark.
    for (const [now, basket, abs] of [
      [100n, 90n, 95n],
      [100n, 95n, 90n],
      [100n, 100n, 90n],
      [100n, 90n, 100n],
      [100n, 110n, 90n],
    ] as const) {
      expect(await harness.chargeableGain(now, basket, abs)).to.equal(
        math.chargeableGain(now, basket, abs)
      )
    }

    // A basket leg out to a supply and back per share.
    expect(await harness.perShareTotal(WAD / 2n, 1_000n)).to.equal(math.perShareTotal(WAD / 2n, 1_000n))
    expect(await harness.basketPerShare(500n, 1_000n)).to.equal(math.basketPerShare(500n, 1_000n))
    expect(await harness.basketPerShare(1n, 3n)).to.equal(math.basketPerShare(1n, 3n))
    expect(await harness.basketPerShare(500n, 0n)).to.equal(0n)

    // Ratchets up, never down; an empty vault re-bases to par.
    expect(await harness.markAfter(200n, 100n, WAD)).to.equal(2n * WAD)
    expect(await harness.markAfter(50n, 100n, WAD)).to.equal(WAD)
    expect(await harness.markAfter(50n, 0n, 2n * WAD)).to.equal(WAD)
  })

  it('splits a fee accrual so the two legs always sum to the whole', async function () {
    const { harness } = await deployOperatorVault()
    const tenth = WAD / 10n
    // The protocol leg rounds down; the operator keeps the dust.
    for (const [shares, share, op, proto] of [
      [1000n, tenth, 900n, 100n],
      [1009n, tenth, 909n, 100n],
      [9n, tenth, 9n, 0n],
      [1000n, 0n, 1000n, 0n],
      [1000n, WAD, 0n, 1000n],
      [0n, tenth, 0n, 0n],
    ] as const) {
      expect(await harness.splitFee(shares, share)).to.deep.equal([op, proto])
      expect(math.splitFee(shares, share)).to.deep.equal({ operatorShares: op, protocolShares: proto })
    }
  })

  it('reads the trading epoch out of a TS-built Permit2 nonce', async function () {
    const { harness } = await deployOperatorVault()
    const nonce = math.tradingNonce(7n, 99n)
    expect(await harness.epochFromNonce(nonce)).to.equal(7)
    expect(nonce & ((1n << 128n) - 1n)).to.equal(99n)
  })

  it('gives the last claimant the residue', async function () {
    const { harness } = await deployOperatorVault()
    expect(await harness.proRataWithResidue(0, 10, 100)).to.equal(0)
    expect(await harness.proRataWithResidue(3, 0, 100)).to.equal(0)
    expect(await harness.proRataWithResidue(3, 10, 100)).to.equal(30)
    expect(await harness.proRataWithResidue(10, 10, 100)).to.equal(100)
  })

  it('matches the TypeScript reference math', async function () {
    const { harness } = await deployOperatorVault()
    expect(await harness.convertToShares(500, 1000, 2000, false)).to.equal(
      math.convertToShares(500n, 1000n, 2000n)
    )
    expect(await harness.nav(100n, 50n, WAD, 18, 18)).to.equal(math.nav(100n, 50n, WAD, 18, 18))
    expect(await harness.nav(0, 10n ** 18n, WAD, 6, 18)).to.equal(
      math.nav(0n, 10n ** 18n, WAD, 6, 18)
    )
    expect(await harness.nav(0, 2n, WAD, 18, 6)).to.equal(math.nav(0n, 2n, WAD, 18, 6))
    expect(await harness.quotable(10n, 3n)).to.equal(math.quotable(10n, 3n))
    expect(await harness.feeShares(1000n, WAD / 10n, math.YEAR)).to.equal(
      math.feeShares(1000n, WAD / 10n, math.YEAR)
    )
    expect(await harness.proRataWithResidue(2n, 5n, 11n)).to.equal(
      math.proRataWithResidue(2n, 5n, 11n)
    )
  })

  it('matches the TypeScript Permit2 witness digest', async function () {
    const { harness, reactor, permit2 } = await deployOperatorVault()
    const chainId = Number((await ethers.provider.getNetwork()).chainId)
    const params = {
      reactor: reactor as `0x${string}`,
      swapper: ethers.Wallet.createRandom().address as `0x${string}`,
      nonce: 1n << 128n,
      deadline: 1_700_000_000n,
      inputToken: ethers.Wallet.createRandom().address as `0x${string}`,
      inputAmount: 100n,
      outputToken: ethers.Wallet.createRandom().address as `0x${string}`,
      outputAmount: 90n,
      recipient: ethers.Wallet.createRandom().address as `0x${string}`,
      additionalValidationContract: ethers.ZeroAddress as `0x${string}`,
      additionalValidationData: '0x' as `0x${string}`,
    }
    const order = {
      info: {
        reactor: params.reactor,
        swapper: params.swapper,
        nonce: params.nonce,
        deadline: params.deadline,
        additionalValidationContract: params.additionalValidationContract,
        additionalValidationData: params.additionalValidationData,
      },
      input: { token: params.inputToken, amount: params.inputAmount, maxAmount: params.inputAmount },
      outputs: [
        { token: params.outputToken, amount: params.outputAmount, recipient: params.recipient },
      ],
    }
    expect(await harness.permit2Digest(order, permit2, chainId)).to.equal(
      permit2Digest(params, permit2 as `0x${string}`, chainId)
    )
  })

  it('recovers an EOA signer and rejects a wrong key', async function () {
    const { harness, strategy, risk } = await deployOperatorVault()
    const digest = ethers.keccak256(ethers.toUtf8Bytes('vault-lib'))
    const sig = await signDigest(strategy, digest)
    expect(await harness.isSigner(strategy.address, digest, sig)).to.equal(true)
    expect(await harness.isSigner(risk.address, digest, sig)).to.equal(false)
    expect(await harness.isSigner(strategy.address, digest, '0x')).to.equal(false)
  })
})
