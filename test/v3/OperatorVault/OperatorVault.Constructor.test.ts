import { expect } from 'chai'
import { ethers } from 'hardhat'

import {
  DAY,
  defaultInit,
  deployOperatorVault,
  vaultSigners,
} from './fixtures/operatorVault.fixture'

describe('OperatorVault — constructor and views', function () {
  it('reports accounting views and the settlement asset', async function () {
    const { vault, settlement, corridor, factory } = await deployOperatorVault()
    expect(await vault.factory()).to.equal(await factory.getAddress())
    expect(await vault.asset()).to.equal(await settlement.getAddress())
    expect(await vault.settlementAsset()).to.equal(await settlement.getAddress())
    expect(await vault.corridorAsset()).to.equal(await corridor.getAddress())
    expect(await vault.totalAssets()).to.equal(0)
    expect(await vault.freeSettlement()).to.equal(0)
    expect(await vault.freeCorridor()).to.equal(0)
    expect(await vault.quotableSettlement()).to.equal(0)
    expect(await vault.quotableCorridor()).to.equal(0)
    expect(await vault.closeOnly()).to.equal(false)
    expect(await vault.decimals()).to.equal(6)
    expect(await vault.decimals()).to.equal(await vault.settlementDecimals())
    expect(await vault.emergencyExitTimeout()).to.equal(7 * DAY)
  })

  it('rejects a matching asset pair and a fee above the cap', async function () {
    const ctx = await deployOperatorVault()
    const init = defaultInit(ctx)
    init.settlementAsset = await ctx.settlement.getAddress()
    init.corridorAsset = await ctx.settlement.getAddress()
    await expect(ctx.factory.connect(ctx.operatorAdmin).deployVault(init)).to.be.reverted

    const fat = defaultInit(ctx)
    fat.settlementAsset = await ctx.settlement.getAddress()
    fat.corridorAsset = await ctx.corridor.getAddress()
    fat.operatorAdmin = ctx.other.address
    fat.managementFeeWad = 10n ** 17n + 1n
    await expect(ctx.factory.connect(ctx.other).deployVault(fat)).to.be.reverted
  })

  it('rejects tokens with missing or zero decimals', async function () {
    const ctx = await deployOperatorVault()
    const Zero = await ethers.getContractFactory('ZeroDecimalsToken')
    const zero = await Zero.deploy()
    const init = defaultInit(ctx)
    init.settlementAsset = await zero.getAddress()
    init.corridorAsset = await ctx.corridor.getAddress()
    init.operatorAdmin = ctx.other.address
    await expect(ctx.factory.connect(ctx.other).deployVault(init)).to.be.reverted

    const None = await ethers.getContractFactory('NoDecimalsToken')
    const none = await None.deploy()
    init.settlementAsset = await none.getAddress()
    await expect(ctx.factory.connect(ctx.other).deployVault(init)).to.be.reverted

    const High = await ethers.getContractFactory('HighDecimalsToken')
    const high = await High.deploy()
    init.settlementAsset = await high.getAddress()
    await expect(ctx.factory.connect(ctx.other).deployVault(init)).to.be.reverted
  })

  it('rejects a fee-on-transfer deposit', async function () {
    const signers = await vaultSigners()
    const { factory, corridor } = await deployOperatorVault()
    const Fee = await ethers.getContractFactory('FeeOnTransferMock')
    const feeTok = await Fee.deploy('Fee', 'FEE', 6)
    const init = defaultInit(signers)
    init.settlementAsset = await feeTok.getAddress()
    init.corridorAsset = await corridor.getAddress()
    init.operatorAdmin = signers.other.address
    const tx = await factory.connect(signers.other).deployVault(init)
    const receipt = await tx.wait()
    const parsed = receipt!.logs
      .map((l) => {
        try {
          return factory.interface.parseLog(l)
        } catch {
          return null
        }
      })
      .find((p) => p?.name === 'VaultDeployed')
    const vault = await ethers.getContractAt('OperatorVault', parsed!.args.vault)
    await feeTok.mint(signers.lp1.address, 1_000_000_000n)
    await feeTok.connect(signers.lp1).approve(await vault.getAddress(), 1_000_000_000n)
    await expect(
      vault.connect(signers.lp1).requestDeposit(100_000_000n, signers.lp1.address, signers.lp1.address)
    ).to.be.revertedWithCustomError(vault, 'TransferMismatch')
  })

  it('rejects zero controllers and owners', async function () {
    const { vault, lp1 } = await deployOperatorVault()
    await expect(
      vault.connect(lp1).requestDeposit(100_000_000n, ethers.ZeroAddress, lp1.address)
    ).to.be.revertedWithCustomError(vault, 'ZeroAddress')
    await expect(
      vault.connect(lp1).requestRedeem(100_000_000n, lp1.address, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(vault, 'ZeroAddress')
  })
})
