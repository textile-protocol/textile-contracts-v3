<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/textile-protocol/textile-contracts-v3/main/assets/textile-v3-readme-header-dark.png">
  <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/textile-protocol/textile-contracts-v3/main/assets/textile-v3-readme-header-light.png">
  <img alt="Textile swap contracts README header" src="https://raw.githubusercontent.com/textile-protocol/textile-contracts-v3/main/assets/textile-v3-readme-header-light.png">
</picture>

# Textile Swap Contracts

This repository contains the contracts Textile uses to settle swap fills through
a pinned UniswapX `LimitOrderReactor` and Textile's native output-fee controller.
It is meant for integrators, stakeholders, and auditors who need the on-chain
swap surface without unrelated application code.

The contract set is intentionally small:

- `contracts/v3/filler/SellFirstFeeController.sol` - Textile's output-token fee
  controller for sell-first swaps.
- `contracts/v3/filler/vendor/uniswapx/reactors/LimitOrderReactor.sol` -
  the pinned UniswapX limit-order reactor used by Textile.
- `contracts/v3/filler/vendor/**` - the exact Permit2 interfaces, solmate
  files, and UniswapX libraries needed by the reactor.
- `test/v3/FillerReactor/` - Hardhat tests for deployment, fee wiring, Permit2
  signatures, and the reactor fill path.
- `test/foundry/v3/security/SellFirstFeeControllerAuditFindings.t.sol` -
  Foundry regression tests for the fee-controller audit findings.
- `addresses/` - deployment snapshots for the Textile swap contracts.

## Swap Flow

Textile sell-first swaps use UniswapX fixed-price limit orders. A maker signs a
Permit2-backed order that targets Textile's `LimitOrderReactor`. The taker fills
that order through the reactor, and the reactor calls `SellFirstFeeController`
through UniswapX's native `ProtocolFees` hook to append Textile's output-token
fee.

The fee controller has no mutable fee state after deployment. Each deployment
sets an immutable fee recipient and fee bps. The controller aggregates duplicate
output tokens before fee calculation and reverts dust outputs whose floored fee
would be zero.

## UniswapX Lineage

Textile uses a narrow, pinned UniswapX closure for the swap reactor.

| Area | Official UniswapX | Textile swap contracts |
| --- | --- | --- |
| Source pin | [`UniswapX v2.1.0`](https://github.com/Uniswap/UniswapX/tree/v2.1.0) at `df1dbfe2439c3c648ab5e3089953780ab7fc40b7` | Same pinned source for the vendored reactor closure |
| Reactor used | Uniswap ships Dutch, Exclusive Dutch, V2/V3 Dutch, Priority, and Limit reactors | Textile uses only the `LimitOrderReactor` closure for fixed-price swap fills |
| Solidity logic changes | Canonical UniswapX source | No Solidity logic changes inside vendored UniswapX, Permit2 interface, or solmate files |
| Import changes | Foundry remappings in the upstream repo | Import prefixes are rewritten to relative paths plus `@openzeppelin/contracts` so Hardhat and Foundry compile in this package |
| OpenZeppelin | Upstream v2.1.0 imports `openzeppelin-contracts/...` | Resolved to this package's pinned `@openzeppelin/contracts@5.4.0`; the APIs used are unchanged |
| Textile-owned logic | None | `SellFirstFeeController` adds Textile's output-token fee through UniswapX's `ProtocolFees` hook |
| Deployment ownership | Uniswap controlled reactors | Textile deploys and owns the reactor and fee controller addresses listed below |

Pinned third-party source details are in
[`contracts/v3/filler/vendor/VENDORED.md`](contracts/v3/filler/vendor/VENDORED.md).

## Deployed Addresses

### Textile Swap Contracts

| Chain | Textile LimitOrderReactor | SellFirstFeeController | Permit2 | Fee bps |
| --- | --- | --- | --- | --- |
| Base | [0xEb5A29F869FF084B3Fce18d3487a38A56feDC59E](https://basescan.org/address/0xEb5A29F869FF084B3Fce18d3487a38A56feDC59E) | [0x9100D2290fB1eF5AEC1f572a95C1778bF66c8868](https://basescan.org/address/0x9100D2290fB1eF5AEC1f572a95C1778bF66c8868) | [0x000000000022D473030F116dDEE9F6B43aC78BA3](https://basescan.org/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | 5 |
| BNB Smart Chain | [0xe03261c0436DB575F92F09EdDF3591E2566B7D97](https://bscscan.com/address/0xe03261c0436DB575F92F09EdDF3591E2566B7D97) | [0xBDA5e4d85674Fc3A4566B1080A3c59Dc2526c057](https://bscscan.com/address/0xBDA5e4d85674Fc3A4566B1080A3c59Dc2526c057) | [0x000000000022D473030F116dDEE9F6B43aC78BA3](https://bscscan.com/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | 1 |
| Celo | [0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3](https://celoscan.io/address/0xa9AA0a64769cBed4d3B1Ceb4Df01CdE915C235b3) | [0x7b005466F905DD882A959888154587fA76cd3Ea7](https://celoscan.io/address/0x7b005466F905DD882A959888154587fA76cd3Ea7) | [0x000000000022D473030F116dDEE9F6B43aC78BA3](https://celoscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | 5 |
| Polygon | [0xF3ffCF21E621552CFcCC724B965e901cDF0D83fe](https://polygonscan.com/address/0xF3ffCF21E621552CFcCC724B965e901cDF0D83fe) | [0x61296A849412A0955bA8c5A84e124400C68a91D7](https://polygonscan.com/address/0x61296A849412A0955bA8c5A84e124400C68a91D7) | [0x000000000022D473030F116dDEE9F6B43aC78BA3](https://polygonscan.com/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | 5 |

### Official UniswapX References

These are the public UniswapX deployments most relevant for comparison. Textile
does not reuse Uniswap's reactor deployments; it deploys its own
`LimitOrderReactor` instances shown above.

| Chain | Official UniswapX contract | Address | Source |
| --- | --- | --- | --- |
| Ethereum | V3 Dutch Order Reactor | [0x0000000015757c461808EA25Eb309638B62681cf](https://etherscan.io/address/0x0000000015757c461808EA25Eb309638B62681cf) | [source](https://github.com/Uniswap/UniswapX/blob/main/src/reactors/V3DutchOrderReactor.sol) |
| Ethereum | V2 Dutch Order Reactor | [0x00000011F84B9aa48e5f8aA8B9897600006289Be](https://etherscan.io/address/0x00000011F84B9aa48e5f8aA8B9897600006289Be) | [source](https://github.com/Uniswap/UniswapX/blob/v2.0.0/src/reactors/V2DutchOrderReactor.sol) |
| Ethereum | Exclusive Dutch Order Reactor | [0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4](https://etherscan.io/address/0x6000da47483062A0D734Ba3dc7576Ce6A0B645C4) | [source](https://github.com/Uniswap/UniswapX/blob/v1.1.0/src/reactors/ExclusiveDutchOrderReactor.sol) |
| Ethereum | OrderQuoter | [0x54539967a06Fc0E3C3ED0ee320Eb67362D13C5fF](https://etherscan.io/address/0x54539967a06Fc0E3C3ED0ee320Eb67362D13C5fF) | [source](https://github.com/Uniswap/UniswapX/blob/v1.1.0/src/lens/OrderQuoter.sol) |
| Ethereum | Permit2 | [0x000000000022D473030F116dDEE9F6B43aC78BA3](https://etherscan.io/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | [source](https://github.com/Uniswap/permit2) |
| Base | Priority Order Reactor | [0x000000001Ec5656dcdB24D90DFa42742738De729](https://basescan.org/address/0x000000001Ec5656dcdB24D90DFa42742738De729) | [source](https://github.com/Uniswap/UniswapX/blob/v2.1.0/src/reactors/PriorityOrderReactor.sol) |
| Base | OrderQuoter | [0x88440407634f89873c5d9439987ac4be9725fea8](https://basescan.org/address/0x88440407634f89873c5d9439987ac4be9725fea8) | [source](https://github.com/Uniswap/UniswapX/blob/v2.1.0/src/lens/OrderQuoter.sol) |
| Base | Permit2 | [0x000000000022D473030F116dDEE9F6B43aC78BA3](https://basescan.org/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | [source](https://github.com/Uniswap/permit2) |
| Polygon | V3 Dutch Order Reactor | [0x00000000bAB6E234db8AD638B6A6395b7c499Bc4](https://polygonscan.com/address/0x00000000bAB6E234db8AD638B6A6395b7c499Bc4) | [source](https://github.com/Uniswap/UniswapX/blob/main/src/reactors/V3DutchOrderReactor.sol) |
| Polygon | OrderQuoter | [0x00000000a3db63Df9078cBF3dF88B4CAdD5a7F58](https://polygonscan.com/address/0x00000000a3db63Df9078cBF3dF88B4CAdD5a7F58) | [source](https://github.com/Uniswap/UniswapX/blob/main/src/lens/OrderQuoter.sol) |
| Polygon | Permit2 | [0x000000000022D473030F116dDEE9F6B43aC78BA3](https://polygonscan.com/address/0x000000000022D473030F116dDEE9F6B43aC78BA3) | [source](https://github.com/Uniswap/permit2) |
| Celo | UniswapX reactor | not listed in the official UniswapX deployment table | [source](https://github.com/Uniswap/UniswapX#deployment-addresses) |

Source: [UniswapX deployment table](https://github.com/Uniswap/UniswapX#deployment-addresses).

## Upstream UniswapX Audits

The upstream reports below are linked at the same `v2.1.0` source tag used for
the vendored Textile closure:

- [UniswapX v1 ABDK](https://github.com/Uniswap/UniswapX/blob/v2.1.0/audit/v1/ABDK.pdf)
- [UniswapX v1.1 ABDK](https://github.com/Uniswap/UniswapX/blob/v2.1.0/audit/v1.1/ABDK.pdf)
- [UniswapX v1.1 OpenZeppelin](https://github.com/Uniswap/UniswapX/blob/v2.1.0/audit/v1.1/OpenZeppelin.pdf)
- [UniswapX v2 Spearbit](https://github.com/Uniswap/UniswapX/blob/v2.1.0/audit/v2/spearbit.pdf)

Permit2 is not vendored as runtime code here. Textile uses the canonical Permit2
deployment address through UniswapX's `IPermit2` interface.

## Verify Locally

```bash
corepack enable
yarn install --immutable
yarn test:v3
yarn test:foundry:v3
```

`yarn test:v3` runs the Hardhat swap contract tests. `yarn test:foundry:v3`
runs the fee-controller audit regression tests.

## License

Textile-owned smart contracts are licensed under the Business Source License
1.1. See [`licenses/BUSL_LICENSE`](licenses/BUSL_LICENSE). After the applicable
Change Date, the contracts become available under MIT as described in the
license terms.
