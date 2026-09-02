/**
 * EIP-170 guard for the vault deployment path.
 *
 * `VaultDeployer` carries `OperatorVault`'s creation code, so it is the
 * contract that actually runs into the 24,576-byte cap — and it has been
 * within a hundred bytes of it for a while. Without this test the constraint
 * lives only in a comment, and the first person to blow it finds out from a
 * failed mainnet deploy rather than from CI.
 */
import { expect } from 'chai'
import { artifacts } from 'hardhat'

/** EIP-170. */
const MAX_DEPLOYED_BYTES = 24_576

async function deployedSize(name: string): Promise<number> {
  const { deployedBytecode } = await artifacts.readArtifact(name)
  return (deployedBytecode.length - 2) / 2
}

describe('contract sizes', function () {
  // Everything the factory deploys or links, largest first.
  for (const name of ['VaultDeployer', 'VaultPolicy', 'OperatorVaultFactory', 'AaveV3YieldAdapter']) {
    it(`${name} fits under the 24kb cap`, async function () {
      const size = await deployedSize(name)
      expect(
        size,
        `${name} is ${size} bytes, ${size - MAX_DEPLOYED_BYTES} over the ${MAX_DEPLOYED_BYTES} cap`
      ).to.be.at.most(MAX_DEPLOYED_BYTES)
      if (name === 'VaultDeployer') {
        console.log(`      ${name}: ${size}/${MAX_DEPLOYED_BYTES}, ${MAX_DEPLOYED_BYTES - size} bytes spare`)
      }
    })
  }
})
