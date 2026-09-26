# Arena v1 RWA holder-yield

Launch-locked mode for **Instadex Instant** launches quoted in wrapped RWA
(XAUM gold, XAGM silver, USDY T-bills). The standard pit fee slice
(`Config` Instant LP pit-bps, **25%** after `set_instant_lp_split` / **30%**
until then) becomes **claimable `Coin<Q>`** for registered holders instead of
funding the pit pot.

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
| `collect_instadex_fees` (default Instant) | 60/5/25/10 creator / platform / **pit** / VICE | burn via mint lock |
| `collect_instadex_fees_holder_yield` | 60/5/25/10 creator / platform / **vault** / VICE | burn via mint lock |

If the vault has `total_registered == 0` **and is not in push mode**, the
pit-bps balance is returned to the creator residual (same rescue as
undistributable reflection). In **push mode**, the fee is parked in the pot
even with zero registered holders.

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


## Push distribute (option A)

Compatible upgrade: vaults may park the Rewards slice in `reward_pot` for a
**keeper push** instead of magnified-dividend claim.

- DF key: `holder_yield::PushDistributeKey` on vault `id` (value `bool`)
- `is_push_mode(vault)` — `df::exists`
- New vaults (`create_and_share` / migrate) **enable push by default**
- Existing claim-mode vaults: AdminCap `enable_push_distribute` (idempotent)
- `try_fund` in push mode: park fee even when `total_registered == 0`; **do not**
  bump `mps`. Still emits `HolderYieldFundedEvent`.
- Keeper: `push_payout(vault, &AdminCap, recipient, amount, clock)` splits pot →
  `Coin<Q>` to recipient; emits `HolderYieldPushEvent`
- `claim` / `sync_registration` abort with `use_push_distribute` (46) in push mode

```
HolderYieldPushEvent { lock_id, yield_id, recipient, amount, quote, timestamp_ms }
```

Pad Rewards: when vault is push mode, claim note says yield is auto-distributed
by the keeper (no wallet Claim/sync).



## Fee note — Instant LP VICE buyback & burn slice

After `set_instant_lp_split` (60/5/25/10), the **10% VICE buyback & burn** quote slice
(or a launch's own `buyback_bps`) is parked in Config `BuybackBag` (`BuybackBagKey` DF),
not the holder-yield vault. Keepers do **not** route that slice through Claim. The
`keepers` job `burn-vice` (`runBuybackBurnVice`) withdraws it (AdminCap), swaps to
$VICEFUN via 7k and burns it through `launch::burn_from_mint_lock` in one PTB per quote.
Simulate-only by default; live needs `ARENA_VICE_BURN_LIVE=1`.
See `keepers/README.md` § VICE buyback & burn.

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
