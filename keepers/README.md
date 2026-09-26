# Arena keepers

Cron jobs for The Arena launchpad.

**CALL package (mainnet v23):** `0x1c808e5fe7f14703a72cae3cd71ebba98b3a9a97dc530feed6222595bfb4a853` — `config::set_quote_params` + `QuoteParams` DF; Instant LP split 60/5/25/10; plus v22 basket push / v21 holder push / v13 migrate. Default Instant collect still uses `collect_instadex_fees` + pit (rewards slice now 25%). See `contracts/HOLDER_YIELD.md`. Reflection payouts **accrue on every fill** in Move (`pool::buy` / `pool::sell`). Claim-mode vaults still require wallet Claim (the registry table is not iterable). Push-mode vaults use `push-yield` with AdminCap + public holder indexes. They index, and they ring/settle the pit.

## Jobs

| Cron | Path | What |
| --- | --- | --- |
| `* * * * *` | `/api/reflections` | Ingest `TradeEvent` + `ClaimEvent` (kind=0). Snapshot unpaid/claimed per holder. |
| `*/5 * * * *` | `/api/ring` | Sign `config::ring_pit` when Clock >= `round_end_ms` and the previous winner is settled. |
| `*/5 * * * *` | `/api/settle` | Only if `/api/pit-state` has an unsettled 24h MC winner. AdminCap drains `Pit<SUI>`, hops to quote, Bluefin-buys, burns. Then leftover curve `pool::settle_pit` if an on-chain winner is pending. |
| `0 * * * *` | `/api/collect` | Poke collect on Instadex locks with accrued LP fees. Path: `HolderYieldKey` → `collect_instadex_fees_holder_yield`; `BasketYieldKey` → `collect_instadex_fees_basket_yield`; else pit `collect_instadex_fees`. Yield mode from launch/migrate events, with **lock DF fallback** so migrated Instant flips without allowlist. Burns coin A; Instant quote 60/5/25/10 creator/platform/rewards-or-vault/VICE buyback after `set_instant_lp_split`. Then `withdraw` (platform 5%). The VICE buyback bag stays in Config until `burn-vice` swaps it to $VICEFUN and burns it. Home Mac LaunchAgent every 30m (`ARENA_COLLECT_EVERY_S=1800`). |
| `*/15 * * * *` | `/api/convert-basket` | Discover `BasketYieldVault`s with `quote_staging` via `BasketYieldLaunch`/`Funded` GraphQL events. `take_quote_for_convert` → SUI→USDC→RWA hop (same Cetus/Bluefin pools as `settleInstadex`) → `deposit_converted_asset` per weight leg. |
| every tick (Air) | `tsx src/cli.ts hop` | Fetch quote prices and POST `/api/hop`. The site serves that blob. |
| every tick (Air) | `tsx src/cli.ts trades` | Index Bluefin AssetSwap per Instant pool into SQLite (`keepers/data/trades.sqlite`), publish `/api/trades` for the token-page tape, and POST one `/api/screener` snapshot so Explore does not call trades/stats per token. |
| every tick (Air) | `tsx src/cli.ts index-rewards` | Walk basket-yield push events and POST `/api/rewards-index`. Not a Vercel cron. |

HTTP cron routes require `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this). The CLI (`npx tsx src/cli.ts …`) does not.

## Home Mac (no Vercel cron)

The keepers run on the home Mac Air (Jessicas-MacBook-Air / `jessica-m1`), next to `com.eve.arc-sniper` and `com.eve.awake`. Not Vercel, and not the office Mac. Fight Night `refresh()` (launches, Bluefin sqrt MC, bells) runs here as `tsx src/cli.ts pit` and POSTs the blob. Vercel `GET /api/pit-state` only reads that blob. The Fight Night page polls it every 30s; Explore does not.

```
ssh jessica-m1
cd ~/arena-keepers/keepers
./install-local.sh
```

That installs a LaunchAgent (`ai.arena.keepers`) which ticks every 5 minutes. Each tick GETs `/api/pit-state` (that write is what rings the 24h MC bell). Instant buy/burn (`instadex`) runs only when an unsettled winner bell is waiting — not every five minutes of an open round. LP `collect` plus AdminCap `withdraw` of launch fees and the 10% platform bag run every 30 minutes into `0x92a32ac7…` (override `ARENA_COLLECT_EVERY_S`). Leftover curve `ring`/`settle` stay off unless `ARENA_KEEPER_CURVE=1` in `.env.local`. Logs: `~/Library/Logs/arena-keepers.log`.

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
# optional; default 1800 (30m collect + platform withdraw)
# ARENA_COLLECT_EVERY_S=1800
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

**Discovery:** GraphQL `BasketYieldLaunchEvent` (+ `BasketYieldFundedEvent` fallback) on `ARENA_CALL_PACKAGE` (default v13 `0x4b69…`). Loads each vault object; skips if `quote_staging < ARENA_CONVERT_MIN_STAGING` (default `1000000` mist) or `total_registered == 0`.

**On-chain PTB (per vault):**
1. `basket_yield::take_quote_for_convert<T,Q>(vault, amount)`
2. Split Q by `quote_share_for_index` weights (`equal_weight` or explicit bps; floor dust → last leg)
3. Hop each share: **SUI → USDC** (Cetus `USDC_SUI_POOL`) → **XAUM/XAGM** (Bluefin) or **USDY** (Cetus) — same helpers as `settleInstadex`
4. `basket_yield::deposit_converted_asset<T,Q,A>(vault, coin_a, quote_spent, clock)` per leg

**Env**

| Var | Default | Meaning |
| --- | --- | --- |
| `ARENA_CALL_PACKAGE` | v23 `0x1c80…` | Move call package |
| `ARENA_CONVERT_DRY_RUN` | off | `1` = build PTB + `dryRunTransactionBlock` only (no sign) |
| `ARENA_CONVERT_MIN_STAGING` | `1000000` | Skip smaller staging balances |
| `ARENA_CONVERT_VAULT` | — | Optional single vault id |
| `ARENA_CONVERT_WALLET_RWAS` | off | Skip DEX hop; transfer taken Q to keeper and deposit RWA coins already in the wallet |
| `ARENA_KEEPER_PHRASE` | — | Signer (same as other keepers) |

Home Mac `run-local.sh` runs `convert-basket` in the 30m collect window (after `collect`, before `withdraw`). Optional Vercel cron every 15m on `/api/convert-basket` (Bearer `CRON_SECRET`).

**Operator notes:** Prefer dry-run first (`ARENA_CONVERT_DRY_RUN=1`). Non-SUI quote vaults are skipped unless `ARENA_CONVERT_WALLET_RWAS=1`. Bluefin `minOut` is `1` (parity with settle). Collect must run first so staging is funded.


## Basket-yield push distribute

Push remaining RWA pots (`AssetPot`) from a push-mode `BasketYieldVault` pro-rata to
all `$VICEFUN` (or `ARENA_VICEFUN_TYPE`) coin holders — no Claim/sync.

```
ARENA_BASKET_PUSH_VAULT=<vaultId> npx tsx src/cli.ts push-basket          # dry-run
ARENA_BASKET_PUSH_VAULT=<vaultId> ARENA_BASKET_PUSH_LIVE=1 npm run push-basket
```

| Var | Default | Meaning |
| --- | --- | --- |
| `ARENA_BASKET_PUSH_VAULT` | — | Required vault id |
| `ARENA_BASKET_PUSH_LIVE` | off | `1` = sign+execute |
| `ARENA_BASKET_PUSH_BATCH` | `20` | `push_payout`s per PTB |
| `ARENA_GAS_COIN` | — | Optional gas object pin (avoid large reserve coin) |
| `ARENA_CALL_PACKAGE` | v23 `0x1c80…` | Call package (v22+ basket push APIs) |

Requires Compatible v22+ (`enable_push_distribute` first). Does not DEX-hop keeper SUI.

## Holder-yield push distribute

Option A: vaults with `PushDistributeKey` park Rewards quote in `reward_pot`; keeper
pushes pro-rata to **coin holders** (no Claim/sync). Requires Compatible upgrade
(see `contracts/HOLDER_YIELD.md` — **not published yet**).

```
ARENA_PUSH_DRY_RUN=1 npx tsx src/cli.ts push-yield
# live (needs AdminCap on keeper):
ARENA_YIELD_PUSH=1 npx tsx src/cli.ts push-yield
```

`run-local.sh` runs `push-yield` in the collect window when `ARENA_YIELD_PUSH=1`.

| Var | Default | Meaning |
| --- | --- | --- |
| `ARENA_YIELD_PUSH` | off | Enable push job from `run-local.sh` |
| `ARENA_PUSH_DRY_RUN` | off | Log + `dryRunTransactionBlock` only |
| `ARENA_PUSH_MIN_POT` | `1000` | Skip dust pots (mist) |
| `ARENA_PUSH_BATCH` | `20` | `push_payout` calls per PTB |
| `ARENA_PUSH_VAULT` | — | Optional single vault id |
| `ARENA_ADMIN_CAP` | `0x79e041…` | Required for live push |

**Holder indexing:** `fetchCoinHolders(coinType)` tries Suiscan holders API → SuiVision →
Mysten GraphQL `objects(filter:{type: Coin<T>})` aggregated by `AddressOwner`. Excludes
vault / lock / pool addresses and zero balances. Pro-rata: `amount_i = pot * bal_i / supply_held`.



## VICE buyback & burn (`burn-vice`)

The Instant LP split's "VICE buyback" slice accrues in the Config buyback bag
(`BuybackBagKey` DF → `Bag` of `StoredQuote<Q>`). `burn-vice` turns it into a real
$VICEFUN burn. **One PTB per quote coin**, so no VICEFUN ever sits in a wallet:

1. `config::withdraw_buyback<Q>(Config, AdminCap, full bag amount)` (AdminCap holder signs)
2. Swap `Coin<Q>` → VICEFUN through the 7k aggregator (`@bluefin-exchange/bluefin7k-aggregator-sdk`,
   same aggregator as the pad), min-out = quote × (1 − slippage). If 7k has no direct
   Q→VICEFUN route: 7k Q→SUI, then the platform Bluefin VICEFUN/SUI pool
   (`0xcae6…31c5`, the pad's route) with min-out = simulated out × (1 − slippage).
3. `launch::burn_from_mint_lock<VICEFUN>(InstadexMintLock<VICEFUN> 0x9b43…a4e, coin)`.
   The VICEFUN `TreasuryCap` is wrapped in that shared mint lock and the function is
   permissionless, so this is a real `coin::burn` (total supply drops, `InstadexBurnEvent`
   emitted). No 0x0 transfer.

Quotes with no 7k route (e.g. NVDA today) are **skipped and stay in the bag** (never sent
to the keeper wallet). Quotes worth less than `ARENA_VICE_BURN_MIN_SUI` are skipped as dust.
Every run simulates each PTB twice against mainnet (GraphQL `simulateTransaction`) — once
to measure real VICEFUN out, once with the min-out floor — and refuses to execute if the
simulation fails or would leave VICEFUN with the sender. All chain reads, simulation and
execution go through Sui GraphQL (`src/gqlResolve.ts` resolves PTB inputs), not JSON-RPC.

```
npx tsx src/cli.ts burn-vice          # simulate only (default); prints per-quote VICEFUN out
npm run burn-vice
```

`run-local.sh` runs `burn-vice` when `ARENA_VICE_BURN=1` (still simulate-only unless
`ARENA_VICE_BURN_LIVE=1`).

| Var | Default | Meaning |
| --- | --- | --- |
| `ARENA_VICE_BURN` | off | Enable from `run-local.sh` |
| `ARENA_VICE_BURN_LIVE` | off | `1` = sign + execute. Signer (`loadSigner`) must own the AdminCap |
| `ARENA_VICE_BURN_SLIPPAGE` | `0.01` | Fraction for 7k min-out and the Bluefin leg floor |
| `ARENA_VICE_BURN_MIN_SUI` | `50000000` | Skip quotes worth less than this (SUI mist) |
| `ARENA_VICE_BURN_ONLY` | all | Comma list of quote symbols, e.g. `SUI,USDY` |
| `ARENA_VICE_BURN_FORCE_BLUEFIN` | off | Skip direct 7k Q→VICEFUN; use 7k Q→SUI + Bluefin pool |
| `ARENA_VICE_BURN_GAS_BUDGET` | `50000000` | Gas ceiling per PTB (mist) |
| `ARENA_VICE_BURN_SENDER` | AdminCap owner | Simulation sender override |
| `ARENA_VICEFUN_TYPE` / `ARENA_VICEFUN_MINT_LOCK` / `ARENA_VICEFUN_SUI_POOL` | mainnet | Overrides |
| `ARENA_BUYBACK_BAG` | discover DF | Bag id override |

The old `push-vice` job (bag → XAUM/XAGM/USDY → airdrop to VICEFUN holders) is removed;
the buyback slice is now buy-and-burn only. It is in git history if ever needed.

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
- `ARENA_CALL_PACKAGE` (latest published-at, default v13 `0x4b69…`)
- `ARENA_INSTADEX_PACKAGE` (InstadexLaunchEvent type origin v4 `0xcf78…`)
- `SUI_GRAPHQL` (default `https://graphql.mainnet.sui.io/graphql`)
- Platform launch + swap-fee withdraws: Odyssey admin `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b` holds `AdminCap`
- `KEEPERS_CURSOR_PATH`

## Stock wrap attestor

RH → Sui mint keeper lives in `../keepers-stocks/` (CLI mint / watch-rh / webhook).
