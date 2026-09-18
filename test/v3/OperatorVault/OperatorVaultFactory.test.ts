import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import {
  WAD,
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
    expect(await factory.VERSION()).to.equal(2)
  })

  it('names the share token from the init and announces it in VaultDeployed', async function () {
    const deployed = await deployOperatorVault()
    expect(await deployed.vault.name()).to.equal('cNGN/USDT Textile Vault')
    expect(await deployed.vault.symbol()).to.equal('tv-cNGN-USDT')

    const settlement = await deployed.settlement.getAddress()
    const corridor = await deployed.corridor.getAddress()
    const init = defaultInit(deployed)
    init.settlementAsset = settlement
    init.corridorAsset = corridor
    init.name = 'Lagos Desk USDT/cNGN'
    init.symbol = 'LAG-USDT'
    await expect(deployed.factory.connect(deployed.operatorAdmin).deployVault(init))
      .to.emit(deployed.factory, 'VaultDeployed')
      .withArgs(
        anyValue,
        deployed.operatorAdmin.address,
        settlement,
        corridor,
        deployed.strategy.address,
        await deployed.factory.VERSION(),
        init.name,
        init.symbol
      )
    const second = await ethers.getContractAt(
      'OperatorVault',
      await deployed.factory.vaultOf(deployed.operatorAdmin.address, settlement, corridor)
    )
    expect(await second.name()).to.equal(init.name)
    expect(await second.symbol()).to.equal(init.symbol)
  })

  it('rejects an empty or oversized name or symbol', async function () {
    const deployed = await deployOperatorVault()
    const base = defaultInit(deployed)
    base.settlementAsset = await deployed.settlement.getAddress()
    base.corridorAsset = await deployed.corridor.getAddress()
    const deploy = (overrides: Partial<typeof base>) =>
      deployed.factory.connect(deployed.operatorAdmin).deployVault({ ...base, ...overrides })

    for (const overrides of [
      { name: '' },
      { name: 'n'.repeat(65) },
      { symbol: '' },
      { symbol: 's'.repeat(17) },
    ]) {
      await expect(deploy(overrides)).to.be.revertedWithCustomError(
        deployed.factory,
        'InvalidParams'
      )
    }
    // The bounds are inclusive: 64 and 16 bytes deploy.
    await expect(deploy({ name: 'n'.repeat(64), symbol: 's'.repeat(16) })).to.not.be.reverted
  })

  it('lets one operator hold several vaults for the same pair', async function () {
    const deployed = await deployOperatorVault()
    const settlement = await deployed.settlement.getAddress()
    const corridor = await deployed.corridor.getAddress()
    const first = await deployed.vault.getAddress()

    const init = defaultInit(deployed)
    init.settlementAsset = settlement
    init.corridorAsset = corridor
    await expect(deployed.factory.connect(deployed.operatorAdmin).deployVault(init))
      .to.not.be.reverted

    const vaults = await deployed.factory.vaultsOf(
      deployed.operatorAdmin.address,
      settlement,
      corridor
    )
    expect(vaults.length).to.equal(2)
    expect(vaults[0]).to.equal(first)
    // Plain CREATE, so the second vault is a distinct address even though
    // every constructor argument matches the first.
    expect(vaults[1]).to.not.equal(first)
    expect(await deployed.factory.isVault(vaults[1])).to.equal(true)
    expect(
      await deployed.factory.vaultCountOf(
        deployed.operatorAdmin.address,
        settlement,
        corridor
      )
    ).to.equal(2)
  })

  it('answers vaultOf with the most recent vault for the tuple', async function () {
    const deployed = await deployOperatorVault()
    const settlement = await deployed.settlement.getAddress()
    const corridor = await deployed.corridor.getAddress()

    const init = defaultInit(deployed)
    init.settlementAsset = settlement
    init.corridorAsset = corridor
    await deployed.factory.connect(deployed.operatorAdmin).deployVault(init)

    const vaults = await deployed.factory.vaultsOf(
      deployed.operatorAdmin.address,
      settlement,
      corridor
    )
    expect(
      await deployed.factory.vaultOf(deployed.operatorAdmin.address, settlement, corridor)
    ).to.equal(vaults[vaults.length - 1])
  })

  it('reports no vault for a tuple the operator never deployed', async function () {
    const deployed = await deployOperatorVault()
    const settlement = await deployed.settlement.getAddress()
    const corridor = await deployed.corridor.getAddress()
    expect(await deployed.factory.vaultOf(deployed.other.address, settlement, corridor))
      .to.equal(ethers.ZeroAddress)
    expect(
      await deployed.factory.vaultCountOf(deployed.other.address, settlement, corridor)
    ).to.equal(0)
    expect(
      (await deployed.factory.vaultsOf(deployed.other.address, settlement, corridor)).length
    ).to.equal(0)
  })

  it('reverts on a zero factory constructor address', async function () {
    const { vaultDeployer } = await deployOperatorVault()
    const Factory = await ethers.getContractFactory('OperatorVaultFactory', {
      libraries: { VaultDeployer: vaultDeployer },
    })
    const addr = ethers.Wallet.createRandom().address
    await expect(Factory.deploy(ethers.ZeroAddress, addr, addr, addr, addr)).to.be.reverted
    await expect(Factory.deploy(addr, ethers.ZeroAddress, addr, addr, addr)).to.be.reverted
    await expect(Factory.deploy(addr, addr, ethers.ZeroAddress, addr, addr)).to.be.reverted
    // The protocol cut is the one thing an operator cannot change after the
    // fact, so a factory with no recipient or more than half the fee never
    // deploys in the first place.
    await expect(Factory.deploy(addr, addr, addr, addr, ethers.ZeroAddress)).to.be.reverted
    // A zero yield adapter implementation is allowed: yield just cannot be enabled.
    await expect(Factory.deploy(addr, addr, addr, ethers.ZeroAddress, addr)).to.not.be.reverted
  })

  it('records the protocol terms per vault, capped at half of either leg', async function () {
    const deployed = await deployOperatorVault()
    const init = defaultInit(deployed)
    init.settlementAsset = await deployed.settlement.getAddress()
    init.corridorAsset = await deployed.corridor.getAddress()
    init.operatorAdmin = deployed.other.address
    const factory = deployed.factory.connect(deployed.other)

    await expect(
      factory.deployVault({ ...init, protocolManagementShareWad: WAD / 2n + 1n })
    ).to.be.reverted
    await expect(
      factory.deployVault({ ...init, protocolPerformanceShareWad: WAD / 2n + 1n })
    ).to.be.reverted

    const terms = { ...init, protocolManagementShareWad: WAD / 2n, protocolPerformanceShareWad: 0n }
    await expect(factory.deployVault(terms)).to.emit(deployed.factory, 'ProtocolTermsSet')
    const vault = await deployed.factory.vaultOf(
      deployed.other.address,
      init.settlementAsset,
      init.corridorAsset
    )
    const [recipient, managementShare, performanceShare] = await deployed.factory.protocolFeeFor(vault)
    expect(recipient).to.equal(deployed.protocolFeeRecipient.address)
    expect(managementShare).to.equal(WAD / 2n)
    expect(performanceShare).to.equal(0n)
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
  })

  it('hands a vault over to an admin who already runs the same pair', async function () {
    const deployed = await deployOperatorVault()
    const settlement = await deployed.settlement.getAddress()
    const corridor = await deployed.corridor.getAddress()
    const vaultAddr = await deployed.vault.getAddress()

    // lp1 has a book on this pair already. Under the old one-per-tuple index
    // the handover reverted DuplicateVault at accept time, stranding a vault
    // whose operator had already signed it away.
    const taken = defaultInit(deployed)
    taken.settlementAsset = settlement
    taken.corridorAsset = corridor
    taken.operatorAdmin = deployed.lp1.address
    await deployed.factory.connect(deployed.lp1).deployVault(taken)
    const lp1First = await deployed.factory.vaultOf(deployed.lp1.address, settlement, corridor)

    await deployed.vault.connect(deployed.operatorAdmin).transferOperatorAdmin(deployed.lp1.address)
    await expect(deployed.vault.connect(deployed.lp1).acceptOperatorAdmin()).to.not.be.reverted

    const lp1Vaults = await deployed.factory.vaultsOf(deployed.lp1.address, settlement, corridor)
    expect(lp1Vaults.length).to.equal(2)
    expect(lp1Vaults[0]).to.equal(lp1First)
    expect(lp1Vaults[1]).to.equal(vaultAddr)
    expect(
      (await deployed.factory.vaultsOf(deployed.operatorAdmin.address, settlement, corridor)).length
    ).to.equal(0)
  })

  it('rekeys one vault out of a list and leaves the order of the rest', async function () {
    const deployed = await deployOperatorVault()
    const settlement = await deployed.settlement.getAddress()
    const corridor = await deployed.corridor.getAddress()
    const first = await deployed.vault.getAddress()

    // Three vaults on the same tuple, so the removal has something to shift.
    for (let i = 0; i < 2; i++) {
      const init = defaultInit(deployed)
      init.settlementAsset = settlement
      init.corridorAsset = corridor
      await deployed.factory.connect(deployed.operatorAdmin).deployVault(init)
    }
    const before = await deployed.factory.vaultsOf(
      deployed.operatorAdmin.address,
      settlement,
      corridor
    )
    expect(before.length).to.equal(3)

    // Move the oldest, which is the entry a swap-and-pop would scramble.
    await deployed.vault.connect(deployed.operatorAdmin).transferOperatorAdmin(deployed.other.address)
    await deployed.vault.connect(deployed.other).acceptOperatorAdmin()

    const after = await deployed.factory.vaultsOf(
      deployed.operatorAdmin.address,
      settlement,
      corridor
    )
    expect(after.length).to.equal(2)
    expect(after[0]).to.equal(before[1])
    expect(after[1]).to.equal(before[2])
    // vaultOf still answers with the newest of what is left, not the moved one.
    expect(
      await deployed.factory.vaultOf(deployed.operatorAdmin.address, settlement, corridor)
    ).to.equal(before[2])
    expect(
      await deployed.factory.vaultOf(deployed.other.address, settlement, corridor)
    ).to.equal(first)
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
