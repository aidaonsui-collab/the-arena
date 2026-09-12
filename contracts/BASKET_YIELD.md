# Arena v2 RWA basket yield (scaffold)

BidX-style **multi-asset holder rewards** for Instadex Instant launches.
Complements v1 single-quote holder-yield (`HOLDER_YIELD.md` / `holder_yield`).

**Status:** design + Move module skeleton + events/errors + pad notes.
Not wired into `launch` / `lock` collect yet. Do **not** treat as mainnet-live;
`published-at` stays on v11 until a later Compatible upgrade ships the wiring.

## Product

| | v1 holder-yield | v2 basket yield |
| --- | --- | --- |
| Quote pair | Instant quoted **in** one RWA (`Q` = XAUM / XAGM / USDY) | Instant quoted in **SUI** (or another non-basket `Q`) |
| What holders claim | That same `Coin<Q>` | Selected RWAs from a **basket** (gold / silver / T-bills) |
| Fee slice | `std_pit_bps` → vault pot | See [Funding](#funding-from-fee-routes) |
| Payout | Single magnified stream | All-at-once **or** rotating (stubs) |

Initial allowlist (Create / Rewards copy): **XAUM** (gold), **XAGM** (silver),
**USDY** (T-bills). Stocks wraps / `rh-vault` are out of scope.

Later: rotating vs all-at-once modes (stubs exist; production accounting TBD).

## Why a new module

Compatible upgrade constraints (same as v1):

- Prefer **new module** + new public functions + new events.
- No `BluefinPositionLock` / `Config` layout edits — mode via **dynamic field**.
- Do not change `launch_instant` / `collect_instadex_fees` /
  `launch_instant_holder_yield` / `collect_instadex_fees_holder_yield`.
- Mutually exclusive with v1: a lock has either `HolderYieldKey`,
  `BasketYieldKey`, or neither (plain pit). Never both.

Proposed DF (when wired):

- Key: `lock::BasketYieldKey` (not added in this scaffold — documented only)
- Value: `ID` of shared `basket_yield::BasketYieldVault<T, Q>`

## BasketConfig

Launch-locked config owned by the vault (copyable snapshot for events/UI):

```
BasketAsset { asset: TypeName, weight_bps: u64 }
BasketConfig {
  assets: vector<BasketAsset>,  // 1..=3 from allowlist
  equal_weight: bool,           // if true, ignore per-asset bps; split 1/N
  payout_mode: u8,              // 0 = ALL_AT_ONCE, 1 = ROTATING
}
```

Rules (enforced in skeleton `new_config` / `validate_config`):

- `assets` non-empty, length ≤ `MAX_ASSETS` (3).
- Each `asset` must be on the documented RWA allowlist (TypeName check at
  launch when wiring lands; scaffold validates non-zero / no duplicate TypeNames).
- If `equal_weight`: weights may be 0; runtime split uses `BPS / N`.
- Else: each `weight_bps > 0` and sum == `10_000`.
- `payout_mode` ∈ {0, 1}.

## Funding from fee routes

**Proposal (recommended):** reuse the Instant **pit slice** (`Config.std_pit_bps`,
default 30% of collected LP quote B) for basket mode — same diversion pattern as
v1 holder-yield — so creator (60%) / platform (10%) stay untouched and we do not
need a Config layout field.

Flow when wired:

1. `collect_instadex_fees_basket_yield` (name TBD) splits quote B → creator /
   platform / **basket vault quote staging** (`Balance<Q>`), not `Pit<Q>`.
2. A convert step (keeper or permissionless DEX hop) spends staging `Q` into
   allowlisted RWA balances, proportional to `BasketConfig` weights, and parks
   them as per-asset pots (DFs on the vault `UID`).
3. Magnified-dividend (or rotating cursor) accounting credits registered holders.
4. If `total_registered == 0`, return the pit-bps balance to creator residual
   (same rescue as v1 / reflection).

**Alternative:** dedicated `basket_bps` as a **Config DF** (Compatible-safe) if
product later wants pit + basket both live on the same launch (not required for
v2 Instant basket — pit and basket remain mutually exclusive modes).

This scaffold implements **quote staging join** (`try_fund_quote`) as a real
minimal body; **convert / claim / rotate** abort `errors::retired()` until the
next impl slice.

## Custody of multi-asset Balance

- `BasketYieldVault<T, Q>.quote_staging: Balance<Q>` — fee slice before convert.
- Per-RWA pots: **dynamic fields** on `vault.id`, keyed by asset `TypeName`
  (wrapper `AssetPot<A> { bal: Balance<A> }`), so we never put heterogeneous
  `Balance<_>` in one struct field and stay Compatible if new assets are added.
- Registration weight is still `Coin<T>` via `sync_registration` (same caveat as
  v1: no transfer hooks; merge coins first).

## Claim / payout modes

| Mode | Constant | Intended behavior | Scaffold |
| --- | --- | --- | --- |
| All-at-once | `PAYOUT_ALL_AT_ONCE = 0` | One claim pulls pro-rata unpaid across **every** selected RWA | `claim_all` → `retired()` |
| Rotating | `PAYOUT_ROTATING = 1` | Cursor picks one asset per epoch / fund round; claim that stream | `claim_rotating` → `retired()` |

`advance_rotation` / convert helpers are stubs. Magnified-dividend math can
mirror `holder_yield` once pots are live (per-asset `mps` table or single
quote-normalized index — decide in the convert slice).

## Compatible upgrade constraints

- Ship `basket_yield` + event/error helpers first (this PR).
- Next Compatible upgrade: `BasketYieldKey` DF helpers on `lock`, launch entry,
  collect path, convert. No published-at invention here; type origin stays
  `0x5cfd…`.
- Do not break v11 Instant holder-yield (`0xe2dee7…` published-at).
- No stocks / `contracts-stocks` / `rh-vault` changes.

## Events (Rewards dashboard)

Shapes live in `events.move` (emit helpers ready; call sites later):

```
BasketYieldLaunchEvent {
  lock_id, basket_id, bluefin_pool_id,
  token, quote,              // TypeName — pair is TOKEN/Q (often SUI)
  payout_mode,               // u8
  asset_count                // u64 — selected RWA count
}

BasketYieldFundedEvent {
  lock_id, basket_id, bluefin_pool_id,
  quote, amount,             // staging Q credited
  timestamp_ms
}

BasketYieldConvertedEvent {
  lock_id, basket_id,
  from_quote, from_amount,   // Q spent
  to_asset, to_amount,       // RWA credited into pot
  timestamp_ms
}

BasketYieldClaimEvent {
  lock_id, basket_id, who,
  asset, amount,             // TypeName of RWA claimed
  payout_mode
}

BasketYieldRotateEvent {
  lock_id, basket_id,
  from_index, to_index,
  asset,                     // newly active TypeName
  timestamp_ms
}
```

Pad indexes `quote` / `asset` TypeNames to categorize SUI staging vs
XAUM / XAGM / USDY claims. v1 `HolderYield*` events stay unchanged.

## Pad Create UI note

When Create is **not** using single-quote v1 holder-yield, offer:

> **Basket rewards:** pick which RWAs holders earn (XAUM · XAGM · USDY), equal
> weight or custom bps, and payout mode (all-at-once / rotating — rotating
> shipping later). Pair quote can stay **SUI** (or another non-basket quote).
> Fee pit slice funds the basket instead of the Fight Night pit.

Do not show basket picker on the v1 “quote is the RWA” path; modes are exclusive.

## PTB sketch (future)

**Launch:** `launch_instant_basket_yield_entry<T, Q>` — Instant objects +
encoded `BasketConfig` (or parallel type-arg / arg list for selected assets).

**Sync:** `basket_yield::sync_registration` (skeleton: same weight model as v1).

**Collect:** basket collect — Instant collect objects **minus pit**, **plus**
`BasketYieldVault` (no `Pit` arg).

**Convert:** keeper PTB: staging `Q` → RWA pots via Bluefin (out of scope here).

**Claim:** `claim_all` / `claim_rotating` once un-retired.

## Module map

| File | Role |
| --- | --- |
| `sources/basket_yield.move` | Types, validate, staging fund, sync, stubs |
| `sources/events.move` | Basket event structs + emit helpers |
| `sources/errors.move` | Basket abort codes 37–42 |
| `BASKET_YIELD.md` | This design |
| `HOLDER_YIELD.md` | v1 reference (unchanged path) |

## Docs / README

Root / `contracts/README` / keepers / pad footer pointer updates for v11 holder-yield + Rewards are owned by a **separate docs PR**. This scaffold intentionally does not rewrite those files — link `BASKET_YIELD.md` from docs when that PR lands or in a follow-up one-liner.
