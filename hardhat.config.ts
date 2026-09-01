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
      url: firstRpcUrl(process.env.ETH_RPC_URL, 'https://rpc.ankr.com/eth'),
      chainId: 1,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    base: {
      url: firstRpcUrl(process.env.BASE_RPC_URL, 'https://mainnet.base.org'),
      chainId: 8453,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    celo: {
      url: firstRpcUrl(process.env.CELO_RPC_URL, 'https://forno.celo.org'),
      chainId: 42220,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    polygon: {
      url: firstRpcUrl(process.env.POLYGON_RPC_URL, 'https://polygon-rpc.com'),
      chainId: 137,
      accounts: [
        process.env.DEPLOYER_WALLET_MAINNET_PRIVATE_KEY as string,
      ].filter(Boolean),
    },
    bsc: {
      url: firstRpcUrl(
        process.env.BSC_RPC_URL,
        'https://bsc-dataseed.binance.org',
      ),
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
