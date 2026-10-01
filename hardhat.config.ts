require('dotenv').config()

import '@nomicfoundation/hardhat-chai-matchers'
import '@nomicfoundation/hardhat-toolbox-viem'
import '@typechain/hardhat'
import type { HardhatUserConfig } from 'hardhat/config'

const firstRpcUrl = (raw: string | undefined, fallback: string): string =>
  raw
    ?.split(',')
    .map((s) => s.trim())
    .find(Boolean) ?? fallback

/**
 * Network `url` (+ headers) for an RPC env var. Thirdweb RPCs reject a bare
 * client id from Node with 401 Unauthorized — the client id is scoped to our
 * web origins — so server-side calls authenticate with `x-secret-key`. Any
 * other URL goes out as-is.
 */
const rpc = (
  raw: string | undefined,
  fallback: string
): { url: string; httpHeaders?: Record<string, string> } => {
  const url = firstRpcUrl(raw, fallback)
  const secret = process.env.THIRDWEB_SECRET
  return url.includes('.rpc.thirdweb.com/') && secret
    ? { url, httpHeaders: { 'x-secret-key': secret } }
    : { url }
}

const config: HardhatUserConfig = {
  solidity: {
    version: '0.8.30',
    settings: {
      optimizer: {
        enabled: true,
        runs: 1,
      },
      viaIR: true,
      metadata: {
        bytecodeHash: 'none',
      },
    },
  },
  paths: {
    sources: './contracts',
    tests: './test/v3',
    cache: './cache',
    artifacts: './artifacts',
  },
  etherscan: {
    apiKey: {
      mainnet: process.env.ETHERSCAN_API_KEY as string,
      base: process.env.ETHERSCAN_API_KEY as string,
      celo: process.env.ETHERSCAN_API_KEY as string,
      polygon: process.env.ETHERSCAN_API_KEY as string,
      bsc: process.env.ETHERSCAN_API_KEY as string,
    },
    customChains: [
      {
        network: 'base',
        chainId: 8453,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=8453',
          browserURL: 'https://basescan.org',
        },
      },
      {
        network: 'celo',
        chainId: 42220,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=42220',
          browserURL: 'https://celoscan.io',
        },
      },
      {
        network: 'polygon',
        chainId: 137,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=137',
          browserURL: 'https://polygonscan.com',
        },
      },
      {
        network: 'bsc',
        chainId: 56,
        urls: {
          apiURL: 'https://api.etherscan.io/v2/api?chainid=56',
          browserURL: 'https://bscscan.com',
        },
      },
    ],
  },
  networks: {
    localhost: {
      url: process.env.BLOCKCHAIN_RPC_URL || 'http://127.0.0.1:8545',
      chainId: 31337,
    },
    mainnet: {
      ...rpc(process.env.ETH_RPC_URL, 'https://ethereum-rpc.publicnode.com'),
      chainId: 1,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    base: {
      ...rpc(process.env.BASE_RPC_URL, 'https://mainnet.base.org'),
      chainId: 8453,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    celo: {
      ...rpc(process.env.CELO_RPC_URL, 'https://forno.celo.org'),
      chainId: 42220,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    polygon: {
      ...rpc(
        process.env.POLYGON_RPC_URL,
        'https://polygon-bor-rpc.publicnode.com'
      ),
      chainId: 137,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    bsc: {
      ...rpc(process.env.BSC_RPC_URL, 'https://bsc-dataseed.binance.org'),
      chainId: 56,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    hardhat: {
      chainId: 31337,
      mining: {
        auto: true,
        interval: 3000,
      },
    },
  },
}

export default config
