import { expect } from 'chai'
import { ethers } from 'hardhat'

import {
  defaultInit,
  deployOperatorVault,
  vaultSigners,
} from './fixtures/operatorVault.fixture'

describe('OperatorVaultFactory', function () {
  it('deploys a vault and records the operator/corridor tuple', async function () {
    const { factory, vault, settlement, corridor, operatorAdmin, reactor, permit2 } =
      await deployOperatorVault()
    expect(await factory.isVault(await vault.getAddress())).to.equal(true)
    expect(
      await factory.vaultOf(
        operatorAdmin.address,
        await settlement.getAddress(),
        await corridor.getAddress()
      )
    ).to.equal(await vault.getAddress())
    expect(await factory.reactor()).to.equal(reactor)
    expect(await factory.permit2()).to.equal(permit2)
    expect(await factory.VERSION()).to.equal(1)
  })

  it('rejects a duplicate operator/corridor vault', async function () {
    const deployed = await deployOperatorVault()
    const init = defaultInit(deployed)
    init.settlementAsset = await deployed.settlement.getAddress()
    init.corridorAsset = await deployed.corridor.getAddress()
    await expect(
      deployed.factory.connect(deployed.operatorAdmin).deployVault(init)
    ).to.be.reverted
  })

  it('reverts on a zero factory constructor address', async function () {
    const { vaultDeployer } = await deployOperatorVault()
    const Factory = await ethers.getContractFactory('OperatorVaultFactory', {
      libraries: { VaultDeployer: vaultDeployer },
    })
    const addr = ethers.Wallet.createRandom().address
    await expect(Factory.deploy(ethers.ZeroAddress, addr, addr, addr)).to.be.reverted
    await expect(Factory.deploy(addr, ethers.ZeroAddress, addr, addr)).to.be.reverted
    await expect(Factory.deploy(addr, addr, ethers.ZeroAddress, addr)).to.be.reverted
    // A zero yield adapter implementation is allowed: yield just cannot be enabled.
    await expect(Factory.deploy(addr, addr, addr, ethers.ZeroAddress)).to.not.be.reverted
  })

  it('wires Permit2 approvals on the two corridor assets', async function () {
    const { vault, settlement, corridor, permit2 } = await deployOperatorVault()
    expect(await settlement.allowance(await vault.getAddress(), permit2)).to.equal(
      ethers.MaxUint256
    )
    expect(await corridor.allowance(await vault.getAddress(), permit2)).to.equal(
      ethers.MaxUint256
    )
  })

  it('lets a second operator deploy the same corridor pair', async function () {
    const deployed = await deployOperatorVault()
    const init = defaultInit(deployed)
    init.settlementAsset = await deployed.settlement.getAddress()
    init.corridorAsset = await deployed.corridor.getAddress()
    init.operatorAdmin = deployed.other.address
    await expect(deployed.factory.connect(deployed.other).deployVault(init)).to.not.be
      .reverted
    expect(
      await deployed.factory.vaultOf(
        deployed.other.address,
        await deployed.settlement.getAddress(),
        await deployed.corridor.getAddress()
      )
    ).to.not.equal(ethers.ZeroAddress)
  })

  it('rejects invalid constructor configuration via the factory', async function () {
    const signers = await vaultSigners()
    const { factory, settlement, corridor } = await deployOperatorVault()
    const init = defaultInit(signers)
    init.settlementAsset = await settlement.getAddress()
    init.corridorAsset = await corridor.getAddress()
    init.operatorAdmin = ethers.ZeroAddress
    await expect(factory.deployVault(init)).to.be.reverted
  })

  it('rekeys the factory index when operator admin transfers', async function () {
    const deployed = await deployOperatorVault()
    const settlement = await deployed.settlement.getAddress()
    const corridor = await deployed.corridor.getAddress()
    const vaultAddr = await deployed.vault.getAddress()

    await deployed.vault
      .connect(deployed.operatorAdmin)
      .transferOperatorAdmin(deployed.other.address)
    // Two-step (audit L-01): nothing rekeys until the new admin accepts.
    expect(await deployed.factory.vaultOf(deployed.operatorAdmin.address, settlement, corridor))
      .to.equal(vaultAddr)
    await deployed.vault.connect(deployed.other).acceptOperatorAdmin()

    expect(await deployed.factory.vaultOf(deployed.operatorAdmin.address, settlement, corridor))
      .to.equal(ethers.ZeroAddress)
    expect(await deployed.factory.vaultOf(deployed.other.address, settlement, corridor)).to.equal(
      vaultAddr
    )

    const init = defaultInit(deployed)
    init.settlementAsset = settlement
    init.corridorAsset = corridor
    await expect(
      deployed.factory.connect(deployed.operatorAdmin).deployVault(init)
    ).to.not.be.reverted

    const taken = defaultInit(deployed)
    taken.settlementAsset = settlement
    taken.corridorAsset = corridor
    taken.operatorAdmin = deployed.lp1.address
    await deployed.factory.connect(deployed.lp1).deployVault(taken)
    // The clash with lp1's own vault surfaces at accept time.
    await deployed.vault.connect(deployed.other).transferOperatorAdmin(deployed.lp1.address)
    await expect(
      deployed.vault.connect(deployed.lp1).acceptOperatorAdmin()
    ).to.be.revertedWithCustomError(deployed.factory, 'DuplicateVault')
  })

  it('rejects rekeyOperator from a non-vault', async function () {
    const deployed = await deployOperatorVault()
    await expect(
      deployed.factory.rekeyOperator(
        deployed.operatorAdmin.address,
        deployed.other.address,
        await deployed.settlement.getAddress(),
        await deployed.corridor.getAddress()
      )
    ).to.be.revertedWithCustomError(deployed.factory, 'NotAuthorized')
  })

  it('rejects deployVault from anyone other than operatorAdmin', async function () {
    const deployed = await deployOperatorVault()
    const init = defaultInit(deployed)
    init.settlementAsset = await deployed.settlement.getAddress()
    init.corridorAsset = await deployed.corridor.getAddress()
    init.operatorAdmin = deployed.operatorAdmin.address
    await expect(deployed.factory.connect(deployed.other).deployVault(init)).to.be
      .revertedWithCustomError(deployed.factory, 'NotAuthorized')
  })
})
