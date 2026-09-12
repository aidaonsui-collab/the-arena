# Arena keepers

Cron jobs for The Arena launchpad.

**CALL package (mainnet v12):** `0x1710adbe0293015cac7492b6db0cf871a7af81c5a51cd9d5d99d3aadf9fea161` — includes `holder_yield` / `basket_yield` / `collect_instadex_fees_holder_yield` / `collect_instadex_fees_basket_yield`. Default Instant collect still uses `collect_instadex_fees` + pit. See `contracts/HOLDER_YIELD.md`. Reflection payouts **accrue on every fill** in Move (`pool::buy` / `pool::sell`). Keepers do not push SUI/XAUM to wallets (the holder table is not iterable). They index, and they ring/settle the pit.

## Jobs

| Cron | Path | What |
| --- | --- | --- |
| `* * * * *` | `/api/reflections` | Ingest `TradeEvent` + `ClaimEvent` (kind=0). Snapshot unpaid/claimed per holder. |
| `*/5 * * * *` | `/api/ring` | Sign `config::ring_pit` when Clock >= `round_end_ms` and the previous winner is settled. |
| `*/5 * * * *` | `/api/settle` | Only if `/api/pit-state` has an unsettled 24h MC winner. AdminCap drains `Pit<SUI>`, hops to quote, Bluefin-buys, burns. Then leftover curve `pool::settle_pit` if an on-chain winner is pending. |
| `0 * * * *` | `/api/collect` | Poke collect on Instadex locks with accrued LP fees. Path: `HolderYieldKey` → `collect_instadex_fees_holder_yield`; `BasketYieldKey` → `collect_instadex_fees_basket_yield`; else pit `collect_instadex_fees`. Yield mode from launch/migrate events, with **lock DF fallback** so migrated Instant flips without allowlist. Burns coin A; quote 60/10/30 creator/platform/pit-or-vault. Then `withdraw`. Home Mac LaunchAgent hourly (`ARENA_COLLECT_EVERY_S=3600`). |
| `*/15 * * * *` | `/api/convert-basket` | Discover `BasketYieldVault`s with `quote_staging` via `BasketYieldLaunch`/`Funded` GraphQL events. `take_quote_for_convert` → SUI→USDC→RWA hop (same Cetus/Bluefin pools as `settleInstadex`) → `deposit_converted_asset` per weight leg. |
| every 5 min (Air) | `tsx src/cli.ts trades` | Index Bluefin AssetSwap per Instant pool into SQLite (`keepers/data/trades.sqlite`) and publish `/api/trades` for the token-page tape. Same job sums `InstadexBurnEvent` and pool reserves to `/api/token-stats` so About MC and Burned stay in sync. |

HTTP cron routes require `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this). The CLI (`npx tsx src/cli.ts …`) does not.

## Home Mac (no Vercel cron)

The keepers run on the home Mac Air (Jessicas-MacBook-Air / `jessica-m1`), next to `com.eve.arc-sniper` and `com.eve.awake`. Not Vercel, and not the office Mac. Fight Night `refresh()` (launches, Bluefin sqrt MC, bells) runs here as `tsx src/cli.ts pit` and POSTs the blob. Vercel `GET /api/pit-state` only reads that blob. The Fight Night page polls it every 30s; Explore does not.

```
ssh jessica-m1
cd ~/arena-keepers/keepers
./install-local.sh
```

That installs a LaunchAgent (`ai.arena.keepers`) which ticks every 5 minutes. Each tick GETs `/api/pit-state` (that write is what rings the 24h MC bell). Instant buy/burn (`instadex`) runs only when an unsettled winner bell is waiting — not every five minutes of an open round. LP `collect` plus AdminCap `withdraw` of launch fees and the 10% platform bag run once an hour into `0x92a32ac7…` (override `ARENA_COLLECT_EVERY_S`). Leftover curve `ring`/`settle` stay off unless `ARENA_KEEPER_CURVE=1` in `.env.local`. Logs: `~/Library/Logs/arena-keepers.log`.

```
launchctl bootout gui/$(id -u)/ai.arena.keepers   # stop
./install-local.sh                                # start again
tail -f ~/Library/Logs/arena-keepers.log
```

The Air must be **awake and on Wi‑Fi** when the 24h bell rings (lid open, plugged in, System Settings → Battery → Options → prevent sleep on adapter). Lid closed sleeps the Mac and the bell is missed until the next tick after wake.

Optional `keepers/.env.local` (gitignored) if you want Past-bell tx links written back to the site:

```
CRON_SECRET=same-value-as-the-arena-vercel-project
ARENA_SETTLE_SECRET=same-or-dedicated-secret
# optional; default 3600 (hourly collect + platform withdraw)
# ARENA_COLLECT_EVERY_S=3600
```

`ARENA_SETTLE_SECRET` (or `CRON_SECRET`) is what POSTs the buy/burn digest onto the Fight Night bell. Without it the on-chain settle still runs; Past bells just stay unmarked.

Manual one-shot (no LaunchAgent):

```
npx tsx src/cli.ts instadex
npx tsx src/cli.ts collect
npx tsx src/cli.ts withdraw
npx tsx src/cli.ts trades
```


## Basket yield convert

Permissionless convert of Instant **basket** vault `quote_staging` (usually SUI) into allowlisted RWAs (XAUM / XAGM / USDY) so holders can claim pots.

```
npx tsx src/cli.ts convert-basket
# or
npm run convert-basket
```

**Discovery:** GraphQL `BasketYieldLaunchEvent` (+ `BasketYieldFundedEvent` fallback) on `ARENA_CALL_PACKAGE` (default v12 `0x1710…`). Loads each vault object; skips if `quote_staging < ARENA_CONVERT_MIN_STAGING` (default `1000000` mist) or `total_registered == 0`.

**On-chain PTB (per vault):**
1. `basket_yield::take_quote_for_convert<T,Q>(vault, amount)`
2. Split Q by `quote_share_for_index` weights (`equal_weight` or explicit bps; floor dust → last leg)
3. Hop each share: **SUI → USDC** (Cetus `USDC_SUI_POOL`) → **XAUM/XAGM** (Bluefin) or **USDY** (Cetus) — same helpers as `settleInstadex`
4. `basket_yield::deposit_converted_asset<T,Q,A>(vault, coin_a, quote_spent, clock)` per leg

**Env**

| Var | Default | Meaning |
| --- | --- | --- |
| `ARENA_CALL_PACKAGE` | v12 `0x1710adbe…fea161` | Move call package |
| `ARENA_CONVERT_DRY_RUN` | off | `1` = build PTB + `dryRunTransactionBlock` only (no sign) |
| `ARENA_CONVERT_MIN_STAGING` | `1000000` | Skip smaller staging balances |
| `ARENA_CONVERT_VAULT` | — | Optional single vault id |
| `ARENA_CONVERT_WALLET_RWAS` | off | Skip DEX hop; transfer taken Q to keeper and deposit RWA coins already in the wallet |
| `ARENA_KEEPER_PHRASE` | — | Signer (same as other keepers) |

Home Mac `run-local.sh` runs `convert-basket` in the hourly collect window (after `collect`, before `withdraw`). Optional Vercel cron every 15m on `/api/convert-basket` (Bearer `CRON_SECRET`).

**Operator notes:** Prefer dry-run first (`ARENA_CONVERT_DRY_RUN=1`). Non-SUI quote vaults are skipped unless `ARENA_CONVERT_WALLET_RWAS=1`. Bluefin `minOut` is `1` (parity with settle). Collect must run first so staging is funded.

## Events for the UI indexer

Package `P`. Subscribe:

- `P::events::TradeEvent` — candles, tape, `pit_fee`, `reflection_fee`, `creator_fee`, `platform_fee` (reflection fills include a pit cut)
- `P::events::ClaimEvent` — `kind=0` reflection, `kind=1` pit, `kind=2` creator
- `P::events::LaunchEvent` — `reflection: bool`, quote type
- `P::events::BellEvent` / `PitSettleEvent` / `PitNudgeEvent`
- `P::events::GraduationEvent`
- `P::events::LockEvent` / `LpClaimEvent` — graduated LP time vault
- Latest published-at `::events::InstadexMintLockEvent` — `{ lock_id, mint_lock_id }` (Compatible parallel event)

Instant Create quotes: SUI, USDY (`0x960b…::usdy::USDY`, 6 decimals), XAGM (`0x64bd…::xagm::XAGM`, 9 decimals). Leftover XAUM: `0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM`

Snapshot file (default `./data/reflections.json`) is the shape the token page can read for unpaid quote.

## Env

- `ARENA_PACKAGE_ID`=`0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`
- `SUI_RPC` (default `https://mainnet.suiet.app` — public `fullnode.mainnet.sui.io` JSON-RPC is off)
- `ARENA_PIT_SUI`=`0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`
- `ARENA_PIT_XAUM`=`0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783`
- `ARENA_PIT_USDY` / `ARENA_PIT_XAGM` after `create_pit` + `register_pit`
- `ARENA_CONFIG`=`0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`
- `ARENA_KEEPER_PHRASE` optional. Instant buy/burn needs the platform wallet that holds `AdminCap` (`0x92a32ac7…`). If unset, collect/ring/curve-settle sign with the local Sui keystore.
- `ARENA_ADMIN_CAP`=`0x79e041a4444971bfbf8000925ac3386d8351a3e997eb7d838d84eb6c3e507acf`
- `ARENA_APP_URL` (default `https://the-arena-vert.vercel.app`) so settle can read/write `/api/pit-state`
- `CRON_SECRET` required on Vercel so `/api/{ring,settle,collect,reflections}` are not public. Same secret POSTs the buy/burn digest onto the pit bell (`ARENA_SETTLE_SECRET` also accepted).
- `ARENA_CALL_PACKAGE` (latest published-at, default v12 `0x1710…`)
- `ARENA_INSTADEX_PACKAGE` (InstadexLaunchEvent type origin v4 `0xcf78…`)
- `SUI_GRAPHQL` (default `https://graphql.mainnet.sui.io/graphql`)
- Platform launch + swap-fee withdraws: Odyssey admin `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b` holds `AdminCap`
- `KEEPERS_CURSOR_PATH`

## Stock wrap attestor

RH → Sui mint keeper lives in `../keepers-stocks/` (CLI mint / watch-rh / webhook).
