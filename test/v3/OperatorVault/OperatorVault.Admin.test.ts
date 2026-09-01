import { time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { DAY, ERC1271_FAIL, deployOperatorVault } from './fixtures/operatorVault.fixture'

describe('OperatorVault — admin, pause, signers', function () {
  it('lets only the guardian pause and unpause', async function () {
    const { vault, guardian, lp1 } = await deployOperatorVault()
    await expect(vault.connect(lp1).pause()).to.be.revertedWithCustomError(vault, 'NotAuthorized')
    await vault.connect(guardian).pause()
    expect(await vault.paused()).to.equal(true)
    await expect(vault.connect(guardian).pause()).to.be.revertedWithCustomError(vault, 'InvalidParams')
    const epochBefore = await vault.tradingEpoch()
    await vault.connect(guardian).unpause()
    expect(await vault.paused()).to.equal(false)
    expect(await vault.tradingEpoch()).to.equal(epochBefore)
    await expect(vault.connect(guardian).unpause()).to.be.revertedWithCustomError(
      vault,
      'InvalidParams'
    )
  })

  it('rotates the strategy signer immediately and bumps the trading epoch', async function () {
    const { vault, operatorAdmin, other } = await deployOperatorVault()
    const before = await vault.tradingEpoch()
    await vault.connect(operatorAdmin).setStrategySigner(other.address)
    expect(await vault.strategySigner()).to.equal(other.address)
    expect(await vault.tradingEpoch()).to.equal(before + 1n)
    await expect(vault.connect(operatorAdmin).setStrategySigner(ethers.ZeroAddress)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
    await expect(
      vault.connect(operatorAdmin).setStrategySigner(await vault.riskSigner())
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')
  })

  it('rotates the risk signer only after the delay', async function () {
    const { vault, riskAdmin, other } = await deployOperatorVault()
    await expect(vault.acceptRiskSigner()).to.be.revertedWithCustomError(vault, 'InvalidParams')
    await vault.connect(riskAdmin).proposeRiskSigner(other.address)
    await expect(vault.acceptRiskSigner()).to.be.revertedWithCustomError(
      vault,
      'RotationDelayPending'
    )
    await time.increase(DAY)
    const before = await vault.tradingEpoch()
    await vault.acceptRiskSigner()
    expect(await vault.riskSigner()).to.equal(other.address)
    expect(await vault.tradingEpoch()).to.equal(before + 1n)
  })

  it('clears a pending risk-signer proposal when risk admin transfers', async function () {
    const { vault, riskAdmin, other, lp1 } = await deployOperatorVault()
    await vault.connect(riskAdmin).proposeRiskSigner(other.address)
    await vault.connect(riskAdmin).transferRiskAdmin(lp1.address)
    expect(await vault.pendingRiskSigner()).to.equal(ethers.ZeroAddress)
    expect(await vault.pendingRiskSignerAt()).to.equal(0)
    await time.increase(DAY)
    await expect(vault.acceptRiskSigner()).to.be.revertedWithCustomError(vault, 'InvalidParams')
  })

  it('transfers admin roles and updates guardian and fee recipient', async function () {
    const { vault, operatorAdmin, riskAdmin, other, guardian, feeRecipient } =
      await deployOperatorVault()
    await vault.connect(operatorAdmin).transferOperatorAdmin(other.address)
    expect(await vault.operatorAdmin()).to.equal(other.address)
    await vault.connect(riskAdmin).transferRiskAdmin(other.address)
    expect(await vault.riskAdmin()).to.equal(other.address)
    await vault.connect(other).setGuardian(guardian.address)
    await vault.connect(other).setFeeRecipient(feeRecipient.address)
    await expect(vault.connect(other).setGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      vault,
      'ZeroAddress'
    )
    await expect(vault.connect(other).setFeeRecipient(ethers.ZeroAddress)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
    await expect(vault.connect(other).transferOperatorAdmin(ethers.ZeroAddress)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
    await expect(vault.connect(other).transferRiskAdmin(ethers.ZeroAddress)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
  })

  it('rejects admin calls from the wrong role', async function () {
    const { vault, lp1 } = await deployOperatorVault()
    await expect(vault.connect(lp1).setStrategySigner(lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
    await expect(vault.connect(lp1).proposeRiskSigner(lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
    await expect(vault.connect(lp1).transferOperatorAdmin(lp1.address)).to.be
      .revertedWithCustomError(vault, 'NotAuthorized')
    await expect(vault.connect(lp1).transferRiskAdmin(lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
    await expect(vault.connect(lp1).setGuardian(lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
    await expect(vault.connect(lp1).setFeeRecipient(lp1.address)).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
  })

  it('rejects a risk signer that matches the strategy signer', async function () {
    const { vault, riskAdmin, operatorAdmin, other } = await deployOperatorVault()
    await expect(
      vault.connect(riskAdmin).proposeRiskSigner(await vault.strategySigner())
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')
    await vault.connect(riskAdmin).proposeRiskSigner(other.address)
    await expect(
      vault.connect(operatorAdmin).setStrategySigner(other.address)
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')
  })

  it('rejects a zero pending risk signer', async function () {
    const { vault, riskAdmin } = await deployOperatorVault()
    await expect(vault.connect(riskAdmin).proposeRiskSigner(ethers.ZeroAddress)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
  })

  it('returns the ERC-1271 fail magic while paused', async function () {
    const { vault, guardian } = await deployOperatorVault()
    await vault.connect(guardian).pause()
    const hash = ethers.keccak256('0x1234')
    expect(await vault.isValidSignature(hash, '0x')).to.equal(ERC1271_FAIL)
  })
})
