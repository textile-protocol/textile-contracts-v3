# OperatorVault

Immutable two-asset RFQ maker vault. LPs deposit the settlement asset and hold ERC-20 shares; the operator market-makes between settlement and corridor by co-signing UniswapX LimitOrders (strategy + risk signer) that the vault validates through ERC-1271. See the audit report in `packages/protocol/audits/v3/` for the full trust model.

This file collects the operational constraints that the code cannot enforce. They came out of the OperatorVault security audit (L-04, I-01, I-02, I-04).

## Supported assets (L-04)

Only standard ERC-20s with 1–18 decimals. No rebasing tokens, no fee-on-transfer, no transfer hooks. `_pullExact` rejects fee-on-transfer deposits at the door, but a rebasing settlement asset would silently desynchronise the pending/reserved accounting over time — nothing on-chain catches that. Keep a per-chain allowlist of vetted assets and deploy vaults only for pairs on it.

## Not ERC-4626 (I-02)

The vault exposes shares, `decimals()`, and `totalAssets()`, but it is a request/claim vault, not a drop-in ERC-4626:

- the four `preview*` methods revert — there is no honest preview until an attestation exists
- `totalAssets()` returns `lastSettledNav`, the mark from the last settlement, not a live value
- share price comes from risk-signer NAV attestations, not from `balanceOf`

Integrators must go through `requestDeposit` / `requestRedeem` / `claim`. Anything that calls 4626 conversion helpers will revert or read a stale price.

## Aave position is priced at face value (I-01)

`held()` returns the adapter's aToken balance one-for-one. If Aave is impaired and aTokens are no longer worth par, live NAV and the attested floors inflate together — the on-chain NAV floor cannot detect it. Marking Aave risk down is the risk signer's responsibility: haircut the attested NAV when the position is doubtful. (Withdrawal impairment is handled separately: the emergency exit distributes stranded aTokens in kind, see H-01.)

## Zero-NAV attestations (I-04)

Attesting `nav == 0` while shares are outstanding means the next processed deposit epoch mints essentially the entire vault to the new depositors. That is arithmetically correct for a written-off vault being recapitalised, and the live-NAV floor makes it reachable only in a genuine total-loss state — but it is irreversible. The risk signer must never attest zero NAV with non-zero supply unless a full reset is the explicit intent.

## Timeout ladder ordering

`validateConfig` enforces `emergencyExitTimeout > inKindExitTimeout`, but nothing on-chain orders the ladder against `redemptionEpochDuration` or `valuationTimeout` — deliberately, since legitimate configurations differ per market. When configuring a vault, keep the intended escalation: redemption epoch duration, then cash settlement, then `inKindExitTimeout`, then `emergencyExitTimeout`, and size `valuationTimeout` comfortably past the operator's expected processing window (voiding races processing once it elapses).

## Bytecode budget

`VaultDeployer` embeds the vault's creation code and sits close to the 24 kB runtime cap. New vault logic should go through the linked `VaultPolicy` library (delegatecalled, own budget) rather than the vault body — that's where the admin lifecycle and sweeps already live.
