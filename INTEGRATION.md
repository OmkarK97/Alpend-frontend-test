# INTEGRATION.md — DAR integration & UI-switch playbook

> **Why this file exists.** `lending-loop-frontend` is a **throwaway test UI**. A separate,
> already-built production UI (no DAR integration yet) will replace it. This document is the map so
> that switching is **wiring, not a rebuild** — nobody has to re-derive how the Canton/DAR integration
> works. If you're picking up the new UI, read this top-to-bottom first.

Related deep-dives (Claude memory): `reserve-holding-cid-drift`, `stale-cid-fetch-live-at-submit`,
`ui-migration-portable-integration`.

---

## 1. TL;DR

The React components are a **replaceable skin**. The valuable part is the **integration**: command
payload shapes, disclosed-contract / registry context assembly, Loop wallet signing, and the
operator-signed admin/read layer. That integration lives in **two portable units**:

1. **`server/` (Express Canton proxy)** — reads, operator-signed admin choices, registry/transfer
   context. Framework-agnostic already. **The new UI reuses it unchanged**; just point the new UI's API
   base at the same server.
2. **A browser-side "client core"** — command builders, context plumbing, Loop wallet, config/types/asset
   registry. Pure TypeScript, no React (except the thin hook adapters).

**The switch = point the new UI at the same server + move the client core + wire each screen's action to
the corresponding builder/flow.** Do **not** reinvent payloads or context logic.

---

## 2. Architecture — two data paths

```
                          ┌────────────────────────────────────────────┐
   USER WRITES            │  Browser (UI + client core)                 │
   (supply/borrow/…)      │                                             │
   signed by the USER ───▶│  build*Command()  ──▶  Loop wallet sign ──▶ │──▶ Canton ledger
   via Loop wallet        │  (+ fetchLiveCids, context, disclosed)      │
                          │                                             │
   READS / ADMIN / ───────┼──▶ fetch() ──▶ server/  ──(operator key)──▶ │──▶ Canton ledger + registry
   CONTEXT                │                                             │
                          └────────────────────────────────────────────┘
```

- **User state-changing actions** (supply, withdraw, borrow, repay, liquidate) are assembled **in the
  browser** and signed by the **user's** Loop wallet. The server never signs these.
- **Reads** (positions, reserves, pool status, holdings), **admin choices** (set price, risk params,
  pause, refresh holdings…), and **registry/transfer context** go through the **server**, which signs
  admin choices with the **pool operator** key.

Keep this split. It's the DAR-native security model: only the 3-of-4-gated operator paths move pool funds
via admin choices; user actions are the user's own signature.

---

## 3. The client core (what moves to the new UI)

All framework-agnostic. Copy these into the new UI (or promote to a shared package `@alpend/dar-client`):

| Area | Path | What it is |
|---|---|---|
| Command builders | `src/commands/*.ts` | Pure functions: typed args → Daml `ExerciseCommand` payload + disclosed contracts. `deposit.ts` (supply), `withdraw.ts`, `borrow.ts`, `repay.ts`, `liquidate.ts`, `pool.ts` (initialize user position + pool ops). |
| Context / CIDs | `src/utils/transferContext.ts` | `fetchLiveCids`, `poolCidFromDisclosed`, `fetchTransferContext`, `fetchCCTransferContext`, `fetchCCPayoutContext`, `fetchPoolDisclosedContracts`, `fetchPoolHoldings`. |
| Loop wallet | `src/loop/provider.ts` | `initLoop`, `connectLoop`, `logoutLoop`, `LoopProvider` type. |
| Asset registry | `src/assets.ts` | `ASSETS` (usdcx/cc) — per-asset symbol, `instrumentId`, `isEphemeral`, and the send-context/holdings helpers each asset uses. **Add a new asset here, not in components.** |
| Config | `src/config.ts` | `LENDING_PACKAGE_ID`, `SYNCHRONIZER_ID`, `POOL_OPERATOR`, `ADMIN_API_URL`, template/interface ids, instrument admins. **Single source for DAR-version-sensitive constants.** |
| Types | `src/types.ts` | `DisclosedContract`, `PositionData`, `DepositPosition`, `BorrowPosition`, holdings, etc. |
| Formatting | `src/utils/format.ts` | Human display: `fmtDecimal`, `fmtPercent`, `fmtUsd`, `decimalToPctInput`, `pctInputToDecimal`. |

**React adapters (rewrite/port depending on the new UI's framework):**

| Hook | Path | Role |
|---|---|---|
| `useLoop` | `src/hooks/useLoop.ts` | Wallet connect + `submitTx(operation, payload, message, {estimateTraffic})` + logs. |
| `usePosition` | `src/hooks/usePosition.ts` | Reads positions/holdings, computes USD aggregates + HF locally, `refresh()`. |
| `useAdminData` | `src/hooks/useAdminData.ts` | Reads reserves + oracle prices + pause flags for the Admin page. |
| `useContracts` | `src/hooks/useContracts.ts` | Raw contract listing (ContractExplorer). |

If the new UI is React, these port almost directly. If not, reimplement the same logic over the new
state layer — but keep calling the same client-core functions underneath.

---

## 4. Canonical write-action flow

Every user action follows the same shape (see `src/components/WithdrawModal.tsx` for the reference impl).
**This is the orchestration the new UI must reproduce — ideally lift it into a facade (§7) so a screen
only does "gather inputs → call one method → show result".**

```ts
// 1. Re-resolve current CIDs (never trust a cached position — see memory stale-cid-fetch-live-at-submit)
const live = await fetchLiveCids(partyId);

// 2. Fetch transfer/registry context for the direction:
//    - USER-as-sender  (supply, repay): user's holdings fund the transfer → cfg.fetchUserSendContext(...)
//    - POOL-as-sender  (withdraw, borrow): pool's holdings fund the payout → cfg.fetchPoolSendContext(...)
//      + fetchPoolHoldings(cfg.poolHoldingsPath(POOL_OPERATOR)); ephemeral assets (CC) also need
//      freshReserveHoldingCids covering full liquidity (FIND-025).
const ctx = await cfg.fetchUserSendContext(partyId, amount, holdingCids);

// 3. Assemble + dedupe disclosed contracts; pin the pool CID to the disclosed set.
const disclosed = dedupe([...ctx.disclosedContracts, ...poolHoldings.disclosed]);
const poolCid = poolCidFromDisclosed(disclosed, live.poolCid);

// 4. Build the typed command (DAR field order matters).
const cmd = buildWithdrawTSWithPositionCommand({ poolCid, assetReserveCid: live.reservesByInstrument[cfg.instrumentId], userPositionCid: live.userPositionCid, /* … */ }, disclosed);

// 5. Sign + submit via the user's Loop wallet.
const result = await submitTx('WithdrawTSWithPosition', cmd, 'Withdraw …', { estimateTraffic: false });
```

Encoding rules the builders already handle (keep if you hand-roll anything): **Int and Decimal fields are
JSON strings**; `Optional` = `null` (None) / value (Some); `TextMap` = plain JSON object;
`packageIdSelectionPreference` uses the **hex** package id; template filters use the **`#package-name`**
form (`#alpend-lending-final-loop:Lending.Pool:LendingPool`).

---

## 5. Action → builder → notes

| UI action | Command builder | Direction | Notes |
|---|---|---|---|
| Supply | `buildSupplyTSWithPositionCommand` (`deposit.ts`) | user-as-sender | `existingDepositCid` unifies with an existing position; `enableAsCollateral` flag. |
| Withdraw | `buildWithdrawTSWithPositionCommand` | pool-as-sender | `withdrawAmount = null` = full; DAR auto-caps to max-safe when there's debt. CC needs `freshReserveHoldingCids`. |
| Borrow | `buildBorrowTSWithPositionCommand` | pool-as-sender | `accountReserveCids` = other reserves (HF basket). CC needs `freshReserveHoldingCids`. |
| Repay | `buildRepayTSWithPositionCommand` | user-as-sender | `repayAmount = null` = full. |
| Liquidate | `buildLiquidateTSCommand` (`liquidate.ts`) | two-sided | Operator-mediated disclosure of the borrower's private positions (via `/admin/liquidatable`); repay leg + seize leg. |
| Init user position | `buildInitializeUserPositionCommand` (`pool.ts`) | user | First-time per-user setup. |

---

## 6. Server endpoints (the new UI calls these unchanged)

Base URL = `ADMIN_API_URL` (dev `http://localhost:3100`). Reads + context + admin. Non-exhaustive:

**Reads:** `GET /admin/pool-status`, `GET /admin/asset-reserves`, `GET /query/lending-pool`,
`GET /query/user-position/:party`, `GET /query/deposit-position/:party`, `GET /query/borrow-position/:party`,
`GET /admin/usdcx-holdings/:party`, `GET /admin/cc-holdings/:party`, `GET /admin/liquidatable`.

**Context / disclosure:** `POST /admin/usdcx-transfer-context`, `GET /admin/cc-transfer-context`,
`POST /admin/cc-payout-context`, `GET /admin/pool-disclosed-contracts?party=`.

**Admin choices (operator-signed):** `POST /admin/set-price`, `POST /admin/update-risk-params`,
`POST /admin/update-interest-params`, `POST /admin/set-pause-flags`, `POST /admin/refresh-holdings`,
plus one-time setup (`create-oracle`, `create-pool`, `add-asset-reserve`, `grant-*`, …) and operator
transfers (`send-usdcx`, `send-cc`).

All admin write endpoints resolve the current contract CID server-side and re-point the pool after
consuming choices (`UpdateAssetReserveCid` / `UpdateOracleCid`) — the new UI doesn't manage CIDs for
admin ops.

---

## 7. Target: the `AlpendDarClient` facade (recommended)

The current code smears the §4 flow inside the modal components. Before/while switching, consolidate it
into **one facade** so the UI only calls intent methods:

```ts
interface AlpendDarClient {
  connect(): Promise<{ partyId: string }>;
  getPosition(party: string): Promise<PositionData>;
  supply(a):   Promise<Result>;
  withdraw(a): Promise<Result>;
  borrow(a):   Promise<Result>;
  repay(a):    Promise<Result>;
  liquidate(a):Promise<Result>;
  admin: {
    setPrice, updateRiskParams, updateInterestParams, setPauseFlags, refreshHoldings, /* … */
  };
}
```

Each method internally runs the whole §4 dance. Then a screen is just: gather inputs → call the method →
render the result. **This is the single change that makes any future UI swap trivial** — do it
incrementally (strangler-fig) as each action is touched; don't stop testing for a big-bang refactor.

---

## 8. Env / config the new UI needs

**Frontend (`.env`, Vite — never commit real values):**

| Var | Meaning |
|---|---|
| `VITE_LENDING_PACKAGE_ID` | Current DAR package id (hex). Bump on every DAR rebuild. |
| `VITE_SYNCHRONIZER_ID` | Canton global-domain id (used as `domainId` on disclosed contracts). |
| `VITE_NETWORK` | `testnet` / `mainnet`. |
| `VITE_ADMIN_API_URL` | Base URL of the `server/` proxy. |
| `VITE_CC_INSTRUMENT_ADMIN`, `VITE_USDCX_INSTRUMENT_ADMIN`, `VITE_USDCX_INSTRUMENT_ID`, `VITE_USDCX_HOLDING_INTERFACE_ID` | Token instrument identities for holdings queries. |

**Server (`server/.env`):** `LENDING_PACKAGE_ID`, the **pool operator key** (secrets manager, never in
`.env`), `CANTON_PROXY_URL` (registry), Auth0 token-exchange creds, ledger endpoints. See `server/`.

Loop SDK: pin the version that works (`@fivenorth/loop-sdk`, currently `0.13.1`). Wallet connect breaks on
stale/mismatched SDK versions.

---

## 9. Switching checklist (when the new UI repo arrives)

1. **Stand up the server** the new UI will use (same `server/`, prod deploy) and set its `.env`.
2. **Move the client core** (§3) into the new UI (copy the folders, or install the shared package).
3. **Set the frontend env** (§8) to the current DAR package id + server URL.
4. **Wire the wallet**: connect/disconnect + `submitTx` via `useLoop` (or its equivalent adapter).
5. **Wire reads**: positions/aggregates/HF via `usePosition`; admin data via `useAdminData`.
6. For **each screen action**, call the matching builder/flow (§5) — or the facade method (§7) if extracted.
   Do **not** re-derive payloads/context.
7. **Verify against a live position** on testnet before mainnet: supply → borrow → repay → withdraw →
   liquidate, plus the admin levers.

---

## 10. Gotchas (don't relearn these the hard way)

- **`CONTRACT_NOT_FOUND`, missing id IS in the payload** → cached position stale; use `fetchLiveCids` at
  submit. (memory: `stale-cid-fetch-live-at-submit`)
- **`CONTRACT_NOT_FOUND`, missing id NOT in the payload** → reserve's stored holdings drifted; run
  `POST /admin/refresh-holdings`. (memory: `reserve-holding-cid-drift`)
- **"expected a package name"** → use `#package-name:Module:Entity` in template filters, hex id only in
  `packageIdSelectionPreference` and disclosed `createdEventBlob`s.
- **Int/Decimal must be JSON strings**; `Optional` null/value; `TextMap` = object.
- **Consuming choices churn CIDs** (no contract keys). Every admin write re-points the pool; user actions
  re-resolve via `fetchLiveCids`.
- **Ephemeral CC** needs `freshReserveHoldingCids` covering full liquidity (FIND-025); stable USDCx uses
  the reserve's stored holdings.
- **SCU / amulet version drift** — the participant must have the DAR uploaded + vetted; keep the amulet
  DAR version pinned.
- **~1% USDCx fee gap** — bridged USDCx transfers net less than booked; reconcile with refresh-holdings /
  operator top-up when a full withdraw reports insufficient funds.
```
