# Arena v1 RWA holder-yield

Launch-locked mode for **Instadex Instant** launches quoted in wrapped RWA
(XAUM gold, XAGM silver, USDY T-bills). The standard pit fee slice
(`Config.std_pit_bps`, default **30%** of collected LP quote) becomes
**claimable `Coin<Q>`** for registered holders instead of funding the pit pot.

Curve / Fight Night pit launches are unchanged. Default Instant
(`launch_instant`) still routes that slice to `Pit<Q>`.

## Why claim

Prefer pull claims over push airdrops: holders sync weight, accrue unpaid
quote via magnified dividends (same pattern as `pool` reflection / pit-holder
payouts), then call `holder_yield::claim`. No forced transfers.

## Launch-locked flag

Compatible upgrade: no new field on `BluefinPositionLock`. Mode is a
dynamic field:

- Key: `lock::HolderYieldKey`
- Value: `ID` of the shared `holder_yield::HolderYieldVault<T, Q>`

Set inside `lock::seed_and_lock_instant_holder_yield` /
`launch::launch_instant_holder_yield`, or via
`launch::migrate_instant_to_holder_yield` on an existing plain Instant lock.
Locks without a yield DF stay on the pit path until migrated.

## Fee path

| Path | Quote B split | Token A |
| --- | --- | --- |
| `collect_instadex_fees` (default Instant) | 60/10/30 creator / platform / **pit** | burn via mint lock |
| `collect_instadex_fees_holder_yield` | 60/10/30 creator / platform / **vault** | burn via mint lock |

If the vault has `total_registered == 0`, the pit-bps balance is returned to
the creator residual (same rescue as undistributable reflection), not parked
unclaimable.

Calling the wrong collect aborts: holder-yield lock → `use_holder_yield_collect`
(36); plain lock on the yield collect → `not_holder_yield` (35).

## Registration

Sui coins have no transfer hooks. Holders call
`holder_yield::sync_registration(vault, &coin)` to set registry weight to
`coin.value()` (merge coins first for full wallet weight). Accrues before
updates. Weight is independent of Bluefin LP inventory.

## Events (pad Rewards tab)

```
HolderYieldLaunchEvent { lock_id, yield_id, bluefin_pool_id, token, quote }
HolderYieldFundedEvent { lock_id, yield_id, bluefin_pool_id, quote, amount, timestamp_ms }
HolderYieldClaimEvent  { lock_id, yield_id, who, amount, quote }
```

`quote` is `TypeName` — categorize XAUM / XAGM / USDY on the dashboard.
`CollectLpFeesEvent.pit_amount` still reports the slice size for both paths.


## Migrating existing Instant

Forward-only path for a **plain** Instant `BluefinPositionLock` (no
`HolderYieldKey` / `BasketYieldKey`) already quoted in RWA:

1. Auth: only `lock.beneficiary` (`errors::not_beneficiary` = 22).
2. Create `HolderYieldVault` bound to the existing `lock_id` +
   `bluefin_pool_id` — **no** Bluefin reseed, **no** new lock.
3. `lock::attach_holder_yield` (aborts if already yield:
   `already_locked` = 21 or `yield_mode_conflict` = 44).
4. Emits `HolderYieldLaunchEvent` (same as launch so pad Rewards indexes it).
5. Does **not** touch Pit balances. After migrate, use
   `collect_instadex_fees_holder_yield` (not the pit collect).

| Entrypoint | Role |
| --- | --- |
| `launch::migrate_instant_to_holder_yield<T, Q>` | Non-entry; returns vault id |
| `launch::migrate_instant_to_holder_yield_entry<T, Q>` | Entry wrapper |

## Compatible caveats

- New module + new public functions + new events only; no public visibility
  narrowing; no struct layout edits (DF for mode).
- Do not change `launch_instant` / `collect_instadex_fees` signatures.
- Do not invent published-at IDs; upgrade when ready against live Cap
  (Compatible). Type origin stays `0x5cfd…`.
- Out of scope: multi-asset baskets, rotating BidX, stocks wraps, pad redesign.

## PTB sketch

**Launch:** `launch_instant_holder_yield_entry<T, Q>` — same objects as Instant.

**Migrate (existing Instant):** `migrate_instant_to_holder_yield_entry<T, Q>` — mut lock only (beneficiary).

**Sync:** `holder_yield::sync_registration` with vault + owned `Coin<T>`.

**Collect:** `collect_instadex_fees_holder_yield` — Instant collect objects
**minus pit**, **plus** `HolderYieldVault` (no `Pit` arg).

**Claim:** `holder_yield::claim` → `Coin<Q>`.
