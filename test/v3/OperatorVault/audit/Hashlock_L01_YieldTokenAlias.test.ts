import { expect } from 'chai'
import { ethers } from 'hardhat'

import { defaultInit, deployOperatorVault, type DeployedVault } from '../fixtures/operatorVault.fixture'

/** `AaveV3PoolMock.aTokenOf` sits in slot 1, after `liquidityIndex`. */
const A_TOKEN_OF_SLOT = 1n

// Hashlock L-01: a yield vault accepted an adapter whose yield token was one
// of its working assets. Yield claims pay pro rata from the vault's whole
// balance of that token, so a final claimant could take corridor inventory.
describe('audit Hashlock L-01 — the yield token cannot alias a working asset', function () {
  /** Make the mock Aave pool report `yieldToken` as the settlement asset's aToken. */
  async function setSettlementAToken(ctx: DeployedVault, yieldToken: string) {
    const slot = ethers.solidityPackedKeccak256(
      ['uint256', 'uint256'],
      [await ctx.settlement.getAddress(), A_TOKEN_OF_SLOT]
    )
    await ethers.provider.send('hardhat_setStorageAt', [
      await ctx.aavePool.getAddress(),
      slot,
      ethers.zeroPadValue(yieldToken, 32),
    ])
    expect(await ctx.aavePool.aTokenOf(await ctx.settlement.getAddress())).to.equal(yieldToken)
  }

  async function deployYieldVault(ctx: DeployedVault) {
    const init = defaultInit(ctx, { enableYield: true })
    init.settlementAsset = await ctx.settlement.getAddress()
    init.corridorAsset = await ctx.corridor.getAddress()
    return ctx.factory.connect(ctx.operatorAdmin).deployVault(init)
  }

  it('rejects a yield token equal to the corridor asset', async function () {
    const ctx = await deployOperatorVault({ enableYield: true })
    await setSettlementAToken(ctx, await ctx.corridor.getAddress())
    await expect(deployYieldVault(ctx)).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
  })

  it('rejects a yield token equal to the settlement asset', async function () {
    const ctx = await deployOperatorVault({ enableYield: true })
    await setSettlementAToken(ctx, await ctx.settlement.getAddress())
    await expect(deployYieldVault(ctx)).to.be.revertedWithCustomError(ctx.vault, 'InvalidPair')
  })

  it('still deploys with a distinct yield token', async function () {
    const ctx = await deployOperatorVault({ enableYield: true })
    await expect(deployYieldVault(ctx)).to.emit(ctx.factory, 'VaultDeployed')
  })
})
