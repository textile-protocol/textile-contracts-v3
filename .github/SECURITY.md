# Security Policy

This repository holds the on-chain contracts Textile uses to settle swap fills:
Textile's `SellFirstFeeController` and a pinned UniswapX `LimitOrderReactor`
closure, filled through Permit2. These contracts move user funds, so if you've
found a vulnerability we want to hear from you before anyone else does.

## Reporting a vulnerability

**Do not open a public GitHub issue, pull request, or discussion for a security
bug.** For a live, deployed contract, public disclosure before funds are moved to
safety puts users at direct risk.

Report privately through one of:

- **GitHub private vulnerability reporting** — use the "Report a vulnerability"
  button on the [Security tab](https://github.com/textile-protocol/textile-contracts-v3/security).
  This is the preferred channel.
- **Email** — security@textilecredit.com <!-- TODO: confirm this is a monitored inbox -->

Please include:

- A description of the vulnerability and its impact — what an attacker gains and
  who loses funds.
- The affected contract and chain, ideally with the deployed address from
  `addresses/`.
- A concrete reproduction: a failing Foundry/Hardhat test or a PoC against a
  mainnet fork is ideal. This repo is self-contained — `yarn test:v3` and
  `yarn test:foundry:v3` run locally.
- Your severity assessment and any suggested fix.

Do not test against mainnet deployments or attempt to move other users' funds.
Use a local fork or a fresh deployment.

## What to expect

- **Acknowledgment** within 48 hours.
- **Initial assessment** (severity, in/out of scope) within 5 business days.
- Because the contracts are immutable, a fix usually means a **new deployment and
  a migration of the affected addresses**, not an in-place patch. We'll coordinate
  a disclosure timeline with you that accounts for that. Please don't disclose
  publicly until funds are safe and any migration is complete.
- Credit in the advisory and release notes if you want it — say so in your report.

## Scope

This policy covers **the swap-settlement contracts in this repository only**. The
rest of the Textile protocol (lending pools, reputation, the web app, subgraphs,
and the Stitch operator bot) lives in other repositories and is not covered here.

**In scope**

- `contracts/v3/filler/SellFirstFeeController.sol` — Textile's output-token fee
  controller. Anything that lets an attacker steal or misdirect the fee, redirect
  the immutable fee recipient, mis-calculate or zero out the fee, or brick fills
  by reverting valid orders.
- The wiring **as Textile deploys and uses it**: the `LimitOrderReactor` +
  Permit2 + `SellFirstFeeController` fill path, including the fee-output append
  through UniswapX's `ProtocolFees` hook, output-token aggregation, and dust
  handling.
- The Textile-owned reactor and fee-controller deployments listed in
  `addresses/` (Base, BSC, Celo, Polygon).

**Out of scope**

- Bugs in the canonical, unmodified upstream code vendored here — UniswapX
  (`v2.1.0`), Permit2, solmate, OpenZeppelin — that are **not specific to
  Textile's deployment or usage**. Report those to the respective projects. See
  `contracts/v3/filler/vendor/VENDORED.md` for pins and the upstream audits
  linked in the README. If Textile's specific configuration makes an upstream
  issue exploitable, that **is** in scope — report it.
- The canonical Permit2 deployment itself (Textile uses it by address through
  `IPermit2`, it is not vendored as runtime code here).
- Contracts or addresses not listed in `addresses/`, and any non-production or
  superseded deployment.
- Test-only helpers and mocks (e.g. `BlockableERC20Mock`).
- Economic/MEV observations inherent to fixed-price limit orders (e.g. a filler
  choosing which orders to fill) that don't break the contracts' invariants.
- Gas-optimization or code-quality suggestions with no security impact, and
  automated scanner output without a demonstrated exploit.

## Bug bounty

<!-- TODO: pick one and delete the other -->
There is no formal bug bounty at this time. We may still reward high-impact
reports at our discretion.

<!-- OR, once a program exists:
Rewards are handled through [Immunefi](https://immunefi.com/bounty/textile);
severity and payouts follow the tiers published there. -->

## Supported contracts

The contracts are immutable once deployed, so there are no "supported versions"
to patch. The covered surface is exactly the addresses published in `addresses/`
for the current deployments. When a security fix requires redeployment, the new
addresses land there and the old ones are considered superseded and out of scope.

## Safe harbor

We consider good-faith security research conducted under this policy to be
authorized. We won't pursue legal action against researchers who follow it, avoid
privacy violations and disruption, never move or put at risk funds that aren't
theirs, test only against local forks or their own deployments, and give us
reasonable time to fix and migrate before disclosing. If you're unsure whether
something is authorized, ask first via the channels above.
