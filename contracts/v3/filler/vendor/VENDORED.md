# Vendored code — DO NOT MODIFY LOGIC

This tree is **verbatim, pre-audited** third-party code, copied so the filler
network's green leg (direct sale) settles through UniswapX's audited
`LimitOrderReactor` + Permit2 rather than new Textile cryptography. Keeping it
unmodified is the whole point: any logic change pulls it back into audit scope.

## Pinned sources

| Dependency | Repo | Commit | Tag |
|---|---|---|---|
| UniswapX | github.com/Uniswap/UniswapX | `df1dbfe2439c3c648ab5e3089953780ab7fc40b7` | `v2.1.0` |
| Permit2 | github.com/Uniswap/permit2 | `576f549a7351814f112edcc42f3f8472d1712673` | (UniswapX v2.1.0 submodule) |
| solmate | github.com/transmissions11/solmate | `27545b09183a9852f7655535d3c56f1ca46f018d` | (UniswapX v2.1.0 submodule) |

## Licenses

Each upstream's `LICENSE` file is copied next to its code, unchanged. The SPDX
header on every vendored file is upstream's and stays as is.

| Dependency | License | Text |
|---|---|---|
| UniswapX | GPL-2.0-or-later (per-file SPDX) | `uniswapx/LICENSE` (GPL-3.0, as upstream ships it) |
| solmate | AGPL-3.0-only | `solmate/LICENSE` |
| Permit2 | MIT, Copyright (c) 2022 Uniswap Labs | `permit2/LICENSE` |

The reactor compiles GPL-2.0-or-later and AGPL-3.0-only sources together, so it
falls under AGPL-3.0 as a whole. Commercial use is fine; the source has to stay
public, which it does (explorer verification plus `textile-contracts-v3`).

Textile's FX contracts import this code: the vault hashes orders with
`LimitOrderLib`, and the fee controller and validation callback implement
UniswapX's interfaces. GPL code can't be shipped inside a BUSL work, so every
Textile file compiled together with vendored code is GPL-2.0-or-later
(`../../../../licenses/GPL_LICENSE`), not BUSL. That includes files that only
share a dependency with one, such as the Aave adapter through `VaultErrors`.
Files that never touch it may stay BUSL-1.1.
`test/v3/FillerReactor/LicenseBoundary.test.ts` fails the build if a BUSL file
compiles in GPL or AGPL code.

## OpenZeppelin

UniswapX's two OpenZeppelin imports (`ReentrancyGuard`, `SafeCast`) point at the
repo's existing **OZ v5** (`@openzeppelin/contracts/...`) rather than being
vendored. Both are standard, audited OZ utilities, and the API UniswapX uses
(`nonReentrant`, `SafeCast.toUint256`) is unchanged from v4 to v5 — so this keeps
a single OZ version in the repo with no behavioral difference.

## What's here (LimitOrderReactor closure only — 22 Solidity files, plus each upstream's LICENSE)

- `uniswapx/` — `reactors/{LimitOrderReactor,BaseReactor}`, `base/{ProtocolFees,ReactorEvents,ReactorStructs}`, `interfaces/{IReactor,IReactorCallback,IValidationCallback,IProtocolFeeController}`, `lib/{LimitOrderLib,OrderInfoLib,ResolvedOrderLib,Permit2Lib,CurrencyLibrary}`
- `permit2/src/interfaces/` — `IPermit2`, `ISignatureTransfer`, `IAllowanceTransfer`, `IEIP712`
- `solmate/src/` — `utils/{SafeTransferLib,FixedPointMathLib}`, `tokens/ERC20`, `auth/Owned`

`ReentrancyGuard` + `SafeCast` are *not* vendored — they resolve to the repo's
OZ v5 (see note above).

## The only modification

Import **paths** in the `uniswapx/` files were rewritten from Foundry-remapped
prefixes to relative paths so both Hardhat (node_modules + relative only) and
Foundry resolve them with no remapping:

- `solmate/...` → `../../solmate/...`
- `permit2/...` → `../../permit2/...`
- `openzeppelin-contracts/...` → `@openzeppelin/contracts/...` (the repo's OZ v5)

No Solidity logic was changed. To re-verify, re-fetch the pinned commits and
diff (ignoring the import-prefix rewrites above).

## Upgrading

Bump the pinned commits, re-copy the closure and each upstream `LICENSE`,
re-apply only the import-prefix rewrites, recompile, and re-run the parity +
behavior tests. Never hand-edit. Check the upstream licenses haven't changed;
if one moves to a license that isn't GPL-compatible, the Textile files that
import it need a new look.
