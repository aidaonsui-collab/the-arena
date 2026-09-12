# Arena v2 RWA basket yield

BidX-style **multi-asset holder rewards** for Instadex Instant launches.
Complements v1 single-quote holder-yield (`HOLDER_YIELD.md` / `holder_yield`).

**Status:** wired (launch / collect / convert MVP / claim), **awaiting Compatible
upgrade**. Do **not** invent `published-at`; type origin stays `0x5cfd…` until
the upgrade ships. Mutually exclusive with `HolderYieldKey`.

## Product

| | v1 holder-yield | v2 basket yield |
| --- | --- | --- |
| Quote pair | Instant quoted **in** one RWA (`Q` = XAUM / XAGM / USDY) | Instant quoted in **SUI** (or another non-basket `Q`) |
| What holders claim | That same `Coin<Q>` | Selected RWAs from a **basket** (gold / silver / T-bills) |
| Fee slice | `std_pit_bps` → vault pot | `std_pit_bps` → vault **quote staging**, then convert |
| Payout | Single magnified stream | All-at-once **or** rotating |

Initial allowlist (Create / Rewards copy): **XAUM** (gold), **XAGM** (silver),
**USDY** (T-bills). Stocks wraps / `rh-vault` are out of scope. On-chain checks
validate deposit TypeNames against the vault’s launch-locked `BasketConfig`
(pad should only pass allowlisted types).

## Launch-locked flag

Compatible: no layout edit on `BluefinPositionLock`. Mode is a dynamic field:

- Key: `lock::BasketYieldKey`
- Value: `ID` of shared `basket_yield::BasketYieldVault<T, Q>`

Set inside `lock::seed_and_lock_instant_basket_yield` /
`launch::launch_instant_basket_yield`, or via
`launch::migrate_instant_to_basket_yield` on an existing plain Instant lock.
Never both `HolderYieldKey` and `BasketYieldKey`
(`errors::yield_mode_conflict` = 44).

## Funding from fee routes

Reuse Instant **pit slice** (`Config.std_pit_bps`, default 30% of collected LP
quote B) — same diversion pattern as v1 holder-yield:

1. `collect_instadex_fees_basket_yield` splits quote B → creator / platform /
   **basket vault quote staging** (`Balance<Q>`), not `Pit<Q>`.
2. Convert MVP (permissionless, no in-Move DEX) in one PTB:
   - `take_quote_for_convert(vault, amount)` → `Coin<Q>` to caller (rebate/payment).
   - Off-module / same-PTB swap `Q` → RWAs (keeper/UI).
   - `deposit_converted_asset<A>(vault, coin_a, quote_spent, clock)` per leg —
     asset must be in `BasketConfig`; credits per-asset magnified dividends;
     emits `BasketYieldConvertedEvent`.
   - Weight-proportional quote attribution: `quote_share_for_index(cfg, i, amount)`.
3. If `total_registered == 0`, return the pit-bps balance to creator residual.

Wrong collect aborts: basket lock on pit collect → `use_basket_yield_collect`
(43); plain/holder lock on basket collect → `not_basket_yield` (39).

## Custody

- `quote_staging: Balance<Q>` — fee slice before convert (pro-rata view via
  `pending_quote_normalized`; **not** pull-claimable as Q).
- Per-RWA pots: DF `AssetPotKey { asset }` → `AssetPot<A> { bal }` on vault UID.
- Per-asset mps: `asset_mps` table; per-holder debt: `asset_acc` table.
- Registration: `sync_registration` with `Coin<T>` (merge first).

## Claim / payout modes

| Mode | Constant | Behavior |
| --- | --- | --- |
| All-at-once | `PAYOUT_ALL_AT_ONCE = 0` | `claim_all<A>` / `claim_asset<A>` per leg (pad PTB) |
| Rotating | `PAYOUT_ROTATING = 1` | `claim_rotating<A>` pays cursor asset then `advance_rotation` |


## Migrating existing Instant

Forward-only path for a **plain** Instant `BluefinPositionLock` (no yield DF),
typically quoted in **SUI** (or another non-basket `Q`):

1. Auth: only `lock.beneficiary`.
2. Create `BasketYieldVault` bound to existing `lock_id` + `bluefin_pool_id`
   (no Bluefin reseed / no new lock).
3. `lock::attach_basket_yield`.
4. Emits `BasketYieldLaunchEvent` (reuse so pad Rewards picks up).
5. Pit balances untouched; afterwards use
   `collect_instadex_fees_basket_yield`.

Caller supplies `BasketConfig` (1–3 assets, bps sum 10000 unless equal-weight,
payout mode) — same rules as launch.

| Entrypoint | Role |
| --- | --- |
| `migrate_instant_to_basket_yield` | Non-entry; takes `BasketConfig` |
| `migrate_instant_to_basket_yield_entry<T,Q,A0>` | 1-asset |
| `migrate_instant_to_basket_yield_2_entry<T,Q,A0,A1>` | 2-asset |
| `migrate_instant_to_basket_yield_3_entry<T,Q,A0,A1,A2>` | 3-asset |

## Compatible upgrade constraints

- New module + new public functions + new events/DFs only.
- Do not change `launch_instant` / `collect_instadex_fees` /
  `launch_instant_holder_yield` / `collect_instadex_fees_holder_yield`.
- Do not invent published-at; upgrade when ready (Compatible). Type origin
  `0x5cfd…`. Latest published-at is **v13** `0x4b698b39b8ecaf7f43dfb4126980baff1475da7af3e54f598d0d690f72ecc772` (Compatible upgrade `4RnTz1QgCAwjG8iqmvTXRcad78KxewM5h5Wb15pi6w4X`; basket-yield APIs originated in v12).
- No stocks / `contracts-stocks` / `rh-vault` changes.

## Events (Rewards dashboard)

```
BasketYieldLaunchEvent { lock_id, basket_id, bluefin_pool_id, token, quote, payout_mode, asset_count }
BasketYieldFundedEvent { lock_id, basket_id, bluefin_pool_id, quote, amount, timestamp_ms }
BasketYieldConvertedEvent { lock_id, basket_id, from_quote, from_amount, to_asset, to_amount, timestamp_ms }
BasketYieldClaimEvent { lock_id, basket_id, who, asset, amount, payout_mode }
BasketYieldRotateEvent { lock_id, basket_id, from_index, to_index, asset, timestamp_ms }
```

## Pad Create / entrypoints

When Create is **not** on v1 holder-yield, offer basket picker (XAUM · XAGM ·
USDY), equal or custom bps, payout mode. Pair quote stays **SUI**.

| Entrypoint | Role |
| --- | --- |
| `launch_instant_basket_yield` | Non-entry; takes `BasketConfig` |
| `launch_instant_basket_yield_entry<T,Q,A0>` | 1-asset |
| `launch_instant_basket_yield_2_entry<T,Q,A0,A1>` | 2-asset |
| `launch_instant_basket_yield_3_entry<T,Q,A0,A1,A2>` | 3-asset |
| `migrate_instant_to_basket_yield` / `_entry` / `_2_entry` / `_3_entry` | Migrate plain Instant → basket |
| `collect_instadex_fees_basket_yield` | Collect → staging (no Pit) |
| `basket_yield::sync_registration` | Registry weight |
| `basket_yield::take_quote_for_convert` | Staging Q → keeper |
| `basket_yield::deposit_converted_asset` | RWA → pot + mps |
| `basket_yield::claim_all` / `claim_asset` | All-at-once / building block |
| `basket_yield::claim_rotating` / `advance_rotation` | Rotating |

## Module map

| File | Role |
| --- | --- |
| `sources/basket_yield.move` | Config, vault, fund, convert MVP, claim, rotate |
| `sources/lock.move` | `BasketYieldKey`, seed, collect-to-basket |
| `sources/launch.move` | Launch + collect entrypoints |
| `sources/events.move` | Basket event structs + emit helpers |
| `sources/errors.move` | Basket abort codes 37–44 |
| `BASKET_YIELD.md` | This design |
| `PAD_NOTE_BASKET.md` | Create / Rewards UI note |
