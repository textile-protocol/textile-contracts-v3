import { expect } from 'chai'
import { ethers } from 'hardhat'

describe('PreferredFillerValidation', () => {
  async function fixture() {
    const [reactor, preferred, other] = await ethers.getSigners()
    const Validation = await ethers.getContractFactory(
      'PreferredFillerValidation'
    )
    const validation = await Validation.deploy()
    await validation.waitForDeployment()
    const latest = await ethers.provider.getBlock('latest')
    const exclusiveUntil = BigInt((latest?.timestamp ?? 0) + 60)
    const validationData = ethers.AbiCoder.defaultAbiCoder().encode(
      ['address[]', 'uint256'],
      [[preferred.address], exclusiveUntil]
    )
    const resolvedOrder = {
      info: {
        reactor: reactor.address,
        swapper: other.address,
        nonce: 1,
        deadline: exclusiveUntil + 60n,
        additionalValidationContract: await validation.getAddress(),
        additionalValidationData: validationData,
      },
      input: {
        token: ethers.ZeroAddress,
        amount: 0,
        maxAmount: 0,
      },
      outputs: [],
      sig: '0x',
      hash: ethers.ZeroHash,
    }
    return {
      reactor,
      preferred,
      other,
      validation,
      resolvedOrder,
      exclusiveUntil,
    }
  }

  it('allows a preferred filler during the exclusive window', async () => {
    const { reactor, preferred, validation, resolvedOrder } = await fixture()
    await expect(
      validation.connect(reactor).validate(preferred.address, resolvedOrder)
    ).not.to.be.reverted
  })

  it('rejects another filler during the exclusive window', async () => {
    const { reactor, other, validation, resolvedOrder, exclusiveUntil } =
      await fixture()
    await expect(
      validation.connect(reactor).validate(other.address, resolvedOrder)
    )
      .to.be.revertedWithCustomError(validation, 'FillerNotPreferred')
      .withArgs(other.address, exclusiveUntil)
  })

  it('allows every filler after the exclusive window', async () => {
    const { reactor, other, validation, resolvedOrder, exclusiveUntil } =
      await fixture()
    await ethers.provider.send('evm_setNextBlockTimestamp', [
      Number(exclusiveUntil + 1n),
    ])
    await ethers.provider.send('evm_mine')
    await expect(
      validation.connect(reactor).validate(other.address, resolvedOrder)
    ).not.to.be.reverted
  })

  it('only accepts calls from the order reactor', async () => {
    const { preferred, validation, resolvedOrder } = await fixture()
    await expect(
      validation
        .connect(preferred)
        .validate(preferred.address, resolvedOrder)
    )
      .to.be.revertedWithCustomError(validation, 'InvalidCaller')
      .withArgs(preferred.address)
  })
})
