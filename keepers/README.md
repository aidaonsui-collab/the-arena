# Arena keepers

Cron jobs for The Arena launchpad. Reflection payouts **accrue on every fill** in Move (`pool::buy` / `pool::sell`). Keepers do not push SUI/XAUM to wallets (the holder table is not iterable). They index, and they ring/settle the pit.

## Jobs

| Cron | Path | What |
| --- | --- | --- |
| `* * * * *` | `/api/reflections` | Ingest `TradeEvent` + `ClaimEvent` (kind=0). Snapshot unpaid/claimed per holder. |
| `*/5 * * * *` | `/api/ring` | Sign `pit::ring` when Clock >= `round_end_ms` and the previous winner is settled. |
| `*/5 * * * *` | `/api/settle` | Instant 24h MC winner: AdminCap drains `Pit<SUI>`, hops to quote, Bluefin-buys, burns. Then leftover curve `pool::settle_pit` if an on-chain winner is pending. |
| `0 0 * * *` | `/api/collect` | Poke `launch::collect_instadex_fees` on every Instadex lock with accrued LP fees. Burns coin A, splits quote 60/10/30. Then `withdraw` (`config::withdraw_treasury` + `withdraw_platform`) into the platform wallet. |

HTTP cron routes require `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this). The CLI (`npx tsx src/cli.ts …`) does not.

## Home Mac (no Vercel cron)

The keepers run on the home Mac Air (Jessicas-MacBook-Air / `jessica-m1`), next to `com.eve.arc-sniper` and `com.eve.awake`. Not Vercel, and not the office Mac.

```
ssh jessica-m1
cd ~/arena-keepers/keepers
./install-local.sh
```

That installs a LaunchAgent (`ai.arena.keepers`) which ticks every 5 minutes: Instant buy/burn (`instadex`) as soon as `/api/pit-state` has written the 24h MC bell. LP `collect` plus AdminCap `withdraw` of launch fees and the 10% platform bag run once every 24 hours into `0x92a32ac7…`. Leftover curve `ring`/`settle` stay off unless `ARENA_KEEPER_CURVE=1` in `.env.local`. Logs: `~/Library/Logs/arena-keepers.log`.

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
# optional; default 86400
# ARENA_COLLECT_EVERY_S=86400
```

`ARENA_SETTLE_SECRET` (or `CRON_SECRET`) is what POSTs the buy/burn digest onto the Fight Night bell. Without it the on-chain settle still runs; Past bells just stay unmarked.

Manual one-shot (no LaunchAgent):

```
npx tsx src/cli.ts instadex
npx tsx src/cli.ts collect
npx tsx src/cli.ts withdraw
```

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
- `ARENA_CALL_PACKAGE` (latest published-at, default v8 `0xd853…`)
- `ARENA_INSTADEX_PACKAGE` (InstadexLaunchEvent type origin v4 `0xcf78…`)
- `SUI_GRAPHQL` (default `https://graphql.mainnet.sui.io/graphql`)
- Platform launch + swap-fee withdraws: Odyssey admin `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b` holds `AdminCap`
- `KEEPERS_CURSOR_PATH`
