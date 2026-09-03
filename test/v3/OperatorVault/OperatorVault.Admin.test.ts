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

  it('clears a pending risk-signer proposal when the risk admin hands over', async function () {
    const { vault, riskAdmin, other, lp1 } = await deployOperatorVault()
    await vault.connect(riskAdmin).proposeRiskSigner(other.address)
    await vault.connect(riskAdmin).transferRiskAdmin(lp1.address)
    // Pending signer survives the proposal; it clears (audibly) when lp1 accepts.
    expect(await vault.pendingRiskSigner()).to.equal(other.address)
    await expect(vault.connect(lp1).acceptRiskAdmin())
      .to.emit(vault, 'RiskSignerProposalCancelled')
      .withArgs(other.address)
    expect(await vault.riskAdmin()).to.equal(lp1.address)
    expect(await vault.pendingRiskSigner()).to.equal(ethers.ZeroAddress)
    expect(await vault.pendingRiskSignerAt()).to.equal(0)
  })

  it('withdraws a pending signer proposal when zero is proposed', async function () {
    const { vault, riskAdmin, other, lp1 } = await deployOperatorVault()
    // Nothing pending: zero reverts rather than silently succeeding.
    await expect(
      vault.connect(riskAdmin).proposeRiskSigner(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')
    await vault.connect(riskAdmin).proposeRiskSigner(other.address)
    await time.increase(DAY)
    // Without a cancel, anyone could activate the proposal now (audit L-03).
    await expect(vault.connect(riskAdmin).proposeRiskSigner(ethers.ZeroAddress))
      .to.emit(vault, 'RiskSignerProposalCancelled')
      .withArgs(other.address)
    expect(await vault.pendingRiskSigner()).to.equal(ethers.ZeroAddress)
    expect(await vault.pendingRiskSignerAt()).to.equal(0)
    await expect(vault.connect(lp1).acceptRiskSigner()).to.be.revertedWithCustomError(
      vault,
      'InvalidParams'
    )
  })

  it('transfers admin roles two-step and updates guardian and fee recipient', async function () {
    const { vault, operatorAdmin, riskAdmin, other, lp1, guardian, feeRecipient } =
      await deployOperatorVault()
    // Operator admin: propose, then the new admin accepts (audit L-01).
    await vault.connect(operatorAdmin).transferOperatorAdmin(other.address)
    expect(await vault.operatorAdmin()).to.equal(operatorAdmin.address)
    await expect(vault.connect(lp1).acceptOperatorAdmin()).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
    await expect(vault.connect(other).acceptOperatorAdmin())
      .to.emit(vault, 'OperatorAdminTransferred')
      .withArgs(operatorAdmin.address, other.address)
    expect(await vault.operatorAdmin()).to.equal(other.address)
    expect(await vault.pendingOperatorAdmin()).to.equal(ethers.ZeroAddress)

    // Risk admin: same two-step shape.
    await vault.connect(riskAdmin).transferRiskAdmin(lp1.address)
    expect(await vault.riskAdmin()).to.equal(riskAdmin.address)
    await vault.connect(lp1).acceptRiskAdmin()
    expect(await vault.riskAdmin()).to.equal(lp1.address)

    await vault.connect(other).setGuardian(guardian.address)
    await vault.connect(other).setFeeRecipient(feeRecipient.address)
    await expect(vault.connect(other).setGuardian(ethers.ZeroAddress)).to.be.revertedWithCustomError(
      vault,
      'ZeroAddress'
    )
    await expect(vault.connect(other).setFeeRecipient(ethers.ZeroAddress)).to.be
      .revertedWithCustomError(vault, 'ZeroAddress')
  })

  it('withdraws a pending admin proposal when zero is proposed', async function () {
    const { vault, operatorAdmin, riskAdmin, other, lp1 } = await deployOperatorVault()
    // Nothing pending: zero is a no-op that reverts rather than a silent success.
    await expect(
      vault.connect(operatorAdmin).transferOperatorAdmin(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')
    await expect(
      vault.connect(riskAdmin).transferRiskAdmin(ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')

    await vault.connect(operatorAdmin).transferOperatorAdmin(other.address)
    await expect(vault.connect(operatorAdmin).transferOperatorAdmin(ethers.ZeroAddress))
      .to.emit(vault, 'OperatorAdminProposalCancelled')
      .withArgs(other.address)
    expect(await vault.pendingOperatorAdmin()).to.equal(ethers.ZeroAddress)
    await expect(vault.connect(other).acceptOperatorAdmin()).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )

    await vault.connect(riskAdmin).transferRiskAdmin(lp1.address)
    await expect(vault.connect(riskAdmin).transferRiskAdmin(ethers.ZeroAddress))
      .to.emit(vault, 'RiskAdminProposalCancelled')
      .withArgs(lp1.address)
    expect(await vault.pendingRiskAdmin()).to.equal(ethers.ZeroAddress)
    await expect(vault.connect(lp1).acceptRiskAdmin()).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )

    // A fresh proposal supersedes the previous one outright.
    await vault.connect(operatorAdmin).transferOperatorAdmin(other.address)
    await vault.connect(operatorAdmin).transferOperatorAdmin(lp1.address)
    await expect(vault.connect(other).acceptOperatorAdmin()).to.be.revertedWithCustomError(
      vault,
      'NotAuthorized'
    )
    await vault.connect(lp1).acceptOperatorAdmin()
    expect(await vault.operatorAdmin()).to.equal(lp1.address)
  })

  it('keeps the operator and risk admin roles separate', async function () {
    const { vault, operatorAdmin, riskAdmin, other } = await deployOperatorVault()
    // Proposing the other role's holder is rejected outright.
    await expect(
      vault.connect(operatorAdmin).transferOperatorAdmin(riskAdmin.address)
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')
    await expect(
      vault.connect(riskAdmin).transferRiskAdmin(operatorAdmin.address)
    ).to.be.revertedWithCustomError(vault, 'InvalidParams')
    // And a role change between proposal and accept is re-checked at accept.
    await vault.connect(operatorAdmin).transferOperatorAdmin(other.address)
    await vault.connect(riskAdmin).transferRiskAdmin(other.address)
    await vault.connect(other).acceptRiskAdmin()
    await expect(vault.connect(other).acceptOperatorAdmin()).to.be.revertedWithCustomError(
      vault,
      'InvalidParams'
    )
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

  it('returns the ERC-1271 fail magic while paused', async function () {
    const { vault, guardian } = await deployOperatorVault()
    await vault.connect(guardian).pause()
    const hash = ethers.keccak256('0x1234')
    expect(await vault.isValidSignature(hash, '0x')).to.equal(ERC1271_FAIL)
  })
})
