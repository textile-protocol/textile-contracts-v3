import { SignerWithAddress } from '@nomicfoundation/hardhat-ethers/signers'
import { Wallet, ethers } from 'ethers'
import { ethers as hreEthers } from 'hardhat'

import { CANONICAL_PERMIT2, etchPermit2 } from '../../helpers/etchPermit2'
import {
  AaveV3PoolMock,
  AaveV3YieldAdapter,
  ATokenMock,
  ERC20Mock,
  OperatorVault,
  OperatorVaultFactory,
  VaultLibHarness,
} from '../../../../typechain-types'

export const DAY = 24 * 60 * 60
export const WAD = 10n ** 18n
export const RAY = 10n ** 27n
export const PRICE_1 = WAD
export const ERC1271_MAGIC = '0x1626ba7e'
export const ERC1271_FAIL = '0xffffffff'
export { CANONICAL_PERMIT2 }

export const usdt = (n: bigint) => n * 10n ** 6n
export const cngn = (n: bigint) => n * 10n ** 18n

export interface VaultSigners {
  deployer: SignerWithAddress
  operatorAdmin: SignerWithAddress
  strategy: Wallet
  riskAdmin: SignerWithAddress
  risk: Wallet
  guardian: SignerWithAddress
  feeRecipient: SignerWithAddress
  lp1: SignerWithAddress
  lp2: SignerWithAddress
  other: SignerWithAddress
}

async function fundedWallet(funder: SignerWithAddress): Promise<Wallet> {
  const wallet = Wallet.createRandom().connect(hreEthers.provider)
  await funder.sendTransaction({ to: wallet.address, value: hreEthers.parseEther('10') })
  return wallet
}

export async function vaultSigners(): Promise<VaultSigners> {
  const [deployer, operatorAdmin, riskAdmin, guardian, feeRecipient, lp1, lp2, other] =
    await hreEthers.getSigners()
  const strategy = await fundedWallet(deployer)
  const risk = await fundedWallet(deployer)
  return {
    deployer,
    operatorAdmin,
    strategy,
    riskAdmin,
    risk,
    guardian,
    feeRecipient,
    lp1,
    lp2,
    other,
  }
}

export interface VaultInitOverrides {
  managementFeeWad?: bigint
  minReserveSettlement?: bigint
  minReserveCorridor?: bigint
  minDepositAssets?: bigint
  minRedeemShares?: bigint
  maxOrderLifetime?: bigint
  depositEpochDuration?: number
  redemptionEpochDuration?: number
  redemptionCloseCooldown?: number
  inKindExitTimeout?: number
  emergencyExitTimeout?: number
  valuationTimeout?: number
  riskSignerDelay?: number
  maxOrderInputSettlement?: bigint
  maxOrderInputCorridor?: bigint
  enableYield?: boolean
  minLiquidSettlement?: bigint
  /** Etch the real Permit2 and deploy the vendored LimitOrderReactor +
   *  PreferredFillerValidation instead of random EOA placeholders. */
  realUniswapX?: boolean
}

export interface DeployedVault extends VaultSigners {
  settlement: ERC20Mock
  corridor: ERC20Mock
  vault: OperatorVault
  factory: OperatorVaultFactory
  harness: VaultLibHarness
  reactor: string
  permit2: string
  preferredFiller: string
  vaultPolicy: string
  vaultDeployer: string
  aavePool: AaveV3PoolMock
  aToken: ATokenMock
  adapterImpl: AaveV3YieldAdapter
  /** Vault's bound adapter clone; zero address unless `enableYield`. */
  adapter: AaveV3YieldAdapter
}

export function defaultInit(s: VaultSigners, extras: VaultInitOverrides = {}) {
  return {
    settlementAsset: ethers.ZeroAddress,
    corridorAsset: ethers.ZeroAddress,
    operatorAdmin: s.operatorAdmin.address,
    strategySigner: s.strategy.address,
    riskAdmin: s.riskAdmin.address,
    riskSigner: s.risk.address,
    guardian: s.guardian.address,
    feeRecipient: s.feeRecipient.address,
    maxOrderInputSettlement: extras.maxOrderInputSettlement ?? usdt(100_000n),
    maxOrderInputCorridor: extras.maxOrderInputCorridor ?? cngn(100_000n),
    minReserveSettlement: extras.minReserveSettlement ?? 0n,
    minReserveCorridor: extras.minReserveCorridor ?? 0n,
    maxOrderLifetime: extras.maxOrderLifetime ?? BigInt(2 * 60 * 60),
    depositEpochDuration: extras.depositEpochDuration ?? DAY,
    redemptionEpochDuration: extras.redemptionEpochDuration ?? DAY,
    redemptionCloseCooldown: extras.redemptionCloseCooldown ?? DAY,
    inKindExitTimeout: extras.inKindExitTimeout ?? 3 * DAY,
    emergencyExitTimeout: extras.emergencyExitTimeout ?? 7 * DAY,
    valuationTimeout: extras.valuationTimeout ?? DAY,
    managementFeeWad: extras.managementFeeWad ?? 0n,
    riskSignerDelay: extras.riskSignerDelay ?? DAY,
    minDepositAssets: extras.minDepositAssets ?? usdt(100n),
    minRedeemShares: extras.minRedeemShares ?? usdt(100n),
    enableYield: extras.enableYield ?? false,
    minLiquidSettlement: extras.minLiquidSettlement ?? 0n,
  }
}

async function deployVaultLibraries() {
  const Policy = await hreEthers.getContractFactory('VaultPolicy')
  const policy = await Policy.deploy()
  const vaultPolicy = await policy.getAddress()

  const Deployer = await hreEthers.getContractFactory('VaultDeployer', {
    libraries: { VaultPolicy: vaultPolicy },
  })
  const deployerLib = await Deployer.deploy()
  const vaultDeployer = await deployerLib.getAddress()

  return { vaultPolicy, vaultDeployer }
}

export async function deployOperatorVault(
  extras: VaultInitOverrides = {}
): Promise<DeployedVault> {
  const signers = await vaultSigners()
  const Settlement = await hreEthers.getContractFactory('ERC20Mock')
  const settlement = await Settlement.deploy('USDT', 'USDT', 6)
  const corridor = await Settlement.deploy('cNGN', 'cNGN', 18)

  let reactor: string
  let permit2: string
  let preferredFiller: string
  if (extras.realUniswapX) {
    await etchPermit2()
    permit2 = CANONICAL_PERMIT2
    const Reactor = await hreEthers.getContractFactory('LimitOrderReactor')
    const reactorContract = await Reactor.deploy(permit2, signers.deployer.address)
    reactor = await reactorContract.getAddress()
    const Validation = await hreEthers.getContractFactory('PreferredFillerValidation')
    preferredFiller = await (await Validation.deploy()).getAddress()
  } else {
    reactor = Wallet.createRandom().address
    permit2 = Wallet.createRandom().address
    preferredFiller = Wallet.createRandom().address
  }

  const { vaultPolicy, vaultDeployer } = await deployVaultLibraries()

  // The Aave mock stack only exists for yield-enabled vaults. Without it the
  // handles below point at the zero address and revert loudly if touched.
  const Pool = await hreEthers.getContractFactory('AaveV3PoolMock')
  const AdapterImpl = await hreEthers.getContractFactory('AaveV3YieldAdapter')
  let aavePool = Pool.attach(ethers.ZeroAddress) as AaveV3PoolMock
  let aToken: ATokenMock
  let adapterImpl = AdapterImpl.attach(ethers.ZeroAddress) as AaveV3YieldAdapter
  if (extras.enableYield) {
    aavePool = await Pool.deploy()
    await aavePool.createReserve(await settlement.getAddress())
    aToken = await hreEthers.getContractAt(
      'ATokenMock',
      await aavePool.aTokenOf(await settlement.getAddress())
    )
    adapterImpl = await AdapterImpl.deploy(await aavePool.getAddress())
  } else {
    aToken = await hreEthers.getContractAt('ATokenMock', ethers.ZeroAddress)
  }

  const Factory = await hreEthers.getContractFactory('OperatorVaultFactory', {
    libraries: { VaultDeployer: vaultDeployer },
  })
  const factory = await Factory.deploy(
    reactor,
    permit2,
    preferredFiller,
    await adapterImpl.getAddress()
  )

  const init = defaultInit(signers, extras)
  init.settlementAsset = await settlement.getAddress()
  init.corridorAsset = await corridor.getAddress()

  const tx = await factory.connect(signers.operatorAdmin).deployVault(init)
  const receipt = await tx.wait()
  const log = receipt!.logs.find((l) => {
    try {
      return factory.interface.parseLog(l)?.name === 'VaultDeployed'
    } catch {
      return false
    }
  })
  const parsed = factory.interface.parseLog(log!)
  const vaultAddr = parsed!.args.vault as string

  const vault = await hreEthers.getContractAt('OperatorVault', vaultAddr)
  const adapter = await hreEthers.getContractAt('AaveV3YieldAdapter', await vault.yieldAdapter())

  const Harness = await hreEthers.getContractFactory('VaultLibHarness', {
    libraries: { VaultPolicy: vaultPolicy },
  })
  const harness = await Harness.deploy()

  for (const lp of [signers.lp1, signers.lp2]) {
    await settlement.mint(lp.address, usdt(1_000_000n))
    await corridor.mint(lp.address, cngn(1_000_000n))
    await settlement.connect(lp).approve(vaultAddr, hreEthers.MaxUint256)
    await corridor.connect(lp).approve(vaultAddr, hreEthers.MaxUint256)
  }

  return {
    ...signers,
    settlement,
    corridor,
    vault,
    factory,
    harness,
    reactor,
    permit2,
    preferredFiller,
    vaultPolicy,
    vaultDeployer,
    aavePool,
    aToken,
    adapterImpl,
    adapter,
  }
}

/** Simulate Aave interest: bump the liquidity index and back it with underlying. */
export async function accrueAaveInterest(
  ctx: Pick<DeployedVault, 'aavePool' | 'aToken' | 'settlement' | 'adapter'>,
  newIndexRay: bigint
): Promise<void> {
  const before = await ctx.aToken.balanceOf(await ctx.adapter.getAddress())
  await ctx.aavePool.setLiquidityIndex(newIndexRay)
  const after = await ctx.aToken.balanceOf(await ctx.adapter.getAddress())
  if (after > before) {
    await ctx.settlement.mint(await ctx.aavePool.getAddress(), after - before)
  }
}

export function signDigest(signer: Wallet, digest: string): string {
  return signer.signingKey.sign(digest).serialized
}
