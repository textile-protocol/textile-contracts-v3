import { expect } from 'chai'
import { ethers } from 'hardhat'

import * as math from '../../../constants/src/operatorVaultMath'
import { permit2Digest } from '../helpers/limitOrderPermit2'

import { WAD } from './fixtures/operatorVault.fixture'
import { deployOperatorVault, signDigest } from './fixtures/operatorVault.fixture'

describe('VaultLib', function () {
  it('converts shares and assets with the +1 virtual offset', async function () {
    const { harness } = await deployOperatorVault()
    expect(await harness.convertToShares(1000, 0, 0, false)).to.equal(1000)
    expect(await harness.convertToAssets(1000, 0, 0, false)).to.equal(1000)
    expect(await harness.convertToShares(500, 1000, 1000, false)).to.equal(500)
    expect(await harness.convertToAssets(500, 1000, 1000, true)).to.equal(500)
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
    expect(await harness.feeShares(1000, WAD / 10n, 365 * 24 * 60 * 60)).to.equal(100)
  })

  it('packs and unpacks the trading epoch in the Permit2 nonce', async function () {
    const { harness } = await deployOperatorVault()
    const nonce = await harness.tradingNonce(7, 99)
    expect(await harness.epochFromNonce(nonce)).to.equal(7)
    expect(nonce & ((1n << 128n) - 1n)).to.equal(99)
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
    expect(await harness.tradingNonce(4n, 8n)).to.equal(math.tradingNonce(4n, 8n))
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
