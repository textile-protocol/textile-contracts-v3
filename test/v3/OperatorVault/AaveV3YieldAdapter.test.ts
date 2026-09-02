import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { expect } from 'chai'
import { ethers } from 'hardhat'

import { RAY, usdt } from './fixtures/operatorVault.fixture'

/** Deploy a raw EIP-1167 minimal proxy pointing at `impl`. */
async function deployClone(impl: string, signer: SignerWithAddress): Promise<string> {
  const creation =
    '0x3d602d80600a3d3981f3363d3d373d3d3d363d73' +
    impl.slice(2).toLowerCase() +
    '5af43d82803e903d91602b57fd5bf3'
  const tx = await signer.sendTransaction({ data: creation })
  const receipt = await tx.wait()
  return receipt!.contractAddress!
}

describe('AaveV3YieldAdapter', function () {
  async function deploy() {
    const [deployer, eoaVault, other] = await ethers.getSigners()
    const Token = await ethers.getContractFactory('ERC20Mock')
    const asset = await Token.deploy('USDT', 'USDT', 6)
    const Pool = await ethers.getContractFactory('AaveV3PoolMock')
    const pool = await Pool.deploy()
    await pool.createReserve(await asset.getAddress())
    const aToken = await ethers.getContractAt('ATokenMock', await pool.aTokenOf(await asset.getAddress()))
    const Impl = await ethers.getContractFactory('AaveV3YieldAdapter')
    const impl = await Impl.deploy(await pool.getAddress())
    const adapter = await ethers.getContractAt(
      'AaveV3YieldAdapter',
      await deployClone(await impl.getAddress(), deployer)
    )
    return { deployer, eoaVault, other, asset, pool, aToken, impl, adapter }
  }

  /** Clone bound to an EOA "vault" so deploy/recall can be driven directly. */
  async function deployBound() {
    const ctx = await deploy()
    await ctx.adapter.connect(ctx.eoaVault).initialize(ctx.eoaVault.address, await ctx.asset.getAddress())
    await ctx.asset.mint(ctx.eoaVault.address, usdt(1_000_000n))
    await ctx.asset.connect(ctx.eoaVault).approve(await ctx.adapter.getAddress(), ethers.MaxUint256)
    return ctx
  }

  it('rejects a zero pool and locks the implementation', async function () {
    const { impl, eoaVault, asset } = await deploy()
    const Impl = await ethers.getContractFactory('AaveV3YieldAdapter')
    await expect(Impl.deploy(ethers.ZeroAddress)).to.be.revertedWithCustomError(Impl, 'ZeroAddress')
    await expect(
      impl.connect(eoaVault).initialize(eoaVault.address, await asset.getAddress())
    ).to.be.revertedWithCustomError(impl, 'AlreadyInitialized')
    expect(await impl.vault()).to.equal(await impl.getAddress())
  })

  it('initializes once, binds the caller vault, and resolves the aToken', async function () {
    const { adapter, eoaVault, other, asset, pool, aToken } = await deploy()
    const assetAddr = await asset.getAddress()

    await expect(
      adapter.connect(other).initialize(eoaVault.address, assetAddr)
    ).to.be.revertedWithCustomError(adapter, 'NotAuthorized')
    await expect(
      adapter.connect(eoaVault).initialize(ethers.ZeroAddress, assetAddr)
    ).to.be.revertedWithCustomError(adapter, 'ZeroAddress')

    await expect(adapter.connect(eoaVault).initialize(eoaVault.address, assetAddr))
      .to.emit(adapter, 'AdapterInitialized')
      .withArgs(eoaVault.address, assetAddr, await aToken.getAddress())
    expect(await adapter.vault()).to.equal(eoaVault.address)
    expect(await adapter.asset()).to.equal(assetAddr)
    expect(await adapter.aToken()).to.equal(await aToken.getAddress())
    expect(await asset.allowance(await adapter.getAddress(), await pool.getAddress())).to.equal(
      ethers.MaxUint256
    )

    await expect(
      adapter.connect(eoaVault).initialize(eoaVault.address, assetAddr)
    ).to.be.revertedWithCustomError(adapter, 'AlreadyInitialized')
  })

  it('rejects an asset without an aToken reserve', async function () {
    const { adapter, eoaVault } = await deploy()
    const Token = await ethers.getContractFactory('ERC20Mock')
    const unlisted = await Token.deploy('X', 'X', 18)
    await expect(
      adapter.connect(eoaVault).initialize(eoaVault.address, await unlisted.getAddress())
    ).to.be.revertedWithCustomError(adapter, 'ZeroAddress')
  })

  it('deploys vault funds into the pool and tracks them via held()', async function () {
    const ctx = await deployBound()
    await expect(ctx.adapter.connect(ctx.eoaVault).deploy(usdt(1_000n)))
      .to.emit(ctx.adapter, 'Deployed')
      .withArgs(usdt(1_000n))
    expect(await ctx.adapter.held()).to.equal(usdt(1_000n))
    expect(await ctx.asset.balanceOf(await ctx.pool.getAddress())).to.equal(usdt(1_000n))
    expect(await ctx.asset.balanceOf(await ctx.adapter.getAddress())).to.equal(0n)

    await expect(ctx.adapter.connect(ctx.eoaVault).deploy(0n)).to.be.revertedWithCustomError(
      ctx.adapter,
      'ZeroAmount'
    )
  })

  it('reflects interest through the liquidity index', async function () {
    const ctx = await deployBound()
    await ctx.adapter.connect(ctx.eoaVault).deploy(usdt(1_000n))
    await ctx.pool.setLiquidityIndex((RAY * 11n) / 10n)
    expect(await ctx.adapter.held()).to.equal(usdt(1_100n))
  })

  it('converts face value to scaled units the index cannot move', async function () {
    const ctx = await deployBound()
    await ctx.adapter.connect(ctx.eoaVault).deploy(usdt(1_000n))
    expect(await ctx.adapter.toScaled(usdt(1_000n))).to.equal(usdt(1_000n))

    // The position rebases to 1,100 face; the same position, so the same
    // scaled units. That invariance is what lets the vault add claim weights
    // booked at different moments.
    await ctx.pool.setLiquidityIndex((RAY * 11n) / 10n)
    expect(await ctx.adapter.held()).to.equal(usdt(1_100n))
    expect(await ctx.adapter.toScaled(usdt(1_100n))).to.equal(usdt(1_000n))
    expect(await ctx.adapter.toScaled(await ctx.adapter.held())).to.equal(
      await ctx.aToken.scaledBalanceOf(await ctx.adapter.getAddress())
    )
  })

  it('clamps a transfer to the live position instead of reverting', async function () {
    // Aave's burn rounds the scaled amount up, so a recall that means to
    // leave a reserve behind can land an atomic unit under it. The vault then
    // asks to move its recorded figure; reverting there would freeze the
    // claim it was reserved for permanently, so the adapter sends what it has.
    const ctx = await deployBound()
    await ctx.adapter.connect(ctx.eoaVault).deploy(usdt(1_000n))
    await ctx.pool.setLiquidityIndex((RAY * 11n) / 10n)
    const held = await ctx.adapter.held()

    await ctx.adapter.connect(ctx.eoaVault).transferHeld(ctx.other.address, held + 1n)
    expect(await ctx.aToken.balanceOf(ctx.other.address)).to.equal(held)
    expect(await ctx.adapter.held()).to.equal(0n)
  })

  it('recalls exact amounts and the full position with max', async function () {
    const ctx = await deployBound()
    await ctx.adapter.connect(ctx.eoaVault).deploy(usdt(1_000n))

    const before = await ctx.asset.balanceOf(ctx.eoaVault.address)
    await expect(ctx.adapter.connect(ctx.eoaVault).recall(usdt(400n)))
      .to.emit(ctx.adapter, 'Recalled')
      .withArgs(usdt(400n), usdt(400n))
    expect((await ctx.asset.balanceOf(ctx.eoaVault.address)) - before).to.equal(usdt(400n))
    expect(await ctx.adapter.held()).to.equal(usdt(600n))

    await expect(ctx.adapter.connect(ctx.eoaVault).recall(ethers.MaxUint256))
      .to.emit(ctx.adapter, 'Recalled')
      .withArgs(ethers.MaxUint256, usdt(600n))
    expect(await ctx.adapter.held()).to.equal(0n)
    expect((await ctx.asset.balanceOf(ctx.eoaVault.address)) - before).to.equal(usdt(1_000n))
  })

  it('reverts a recall above the held balance', async function () {
    const ctx = await deployBound()
    await ctx.adapter.connect(ctx.eoaVault).deploy(usdt(100n))
    await expect(ctx.adapter.connect(ctx.eoaVault).recall(usdt(101n))).to.be.reverted
  })

  it('only lets the bound vault deploy and recall', async function () {
    const ctx = await deployBound()
    await ctx.adapter.connect(ctx.eoaVault).deploy(usdt(100n))
    await expect(ctx.adapter.connect(ctx.other).deploy(usdt(1n))).to.be.revertedWithCustomError(
      ctx.adapter,
      'NotAuthorized'
    )
    await expect(ctx.adapter.connect(ctx.other).recall(usdt(1n))).to.be.revertedWithCustomError(
      ctx.adapter,
      'NotAuthorized'
    )
  })
})
