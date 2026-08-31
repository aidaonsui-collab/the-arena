# Arena keepers

Cron jobs for The Arena launchpad. Reflection payouts **accrue on every fill** in Move (`pool::buy` / `pool::sell`). Keepers do not push SUI/XAUM to wallets (the holder table is not iterable). They index, and they ring/settle the pit.

## Jobs

| Cron | Path | What |
| --- | --- | --- |
| `* * * * *` | `/api/reflections` | Ingest `TradeEvent` + `ClaimEvent` (kind=0). Snapshot unpaid/claimed per holder. |
| `*/5 * * * *` | `/api/ring` | Sign `pit::ring` when Clock >= `round_end_ms` and the previous winner is settled. |
| `*/5 * * * *` | `/api/settle` | Sign `pool::settle_pit` on the winning pool. Burn-mode winners that already locked LP forfeit (pot stays). |
| `*/10 * * * *` | `/api/collect` | Poke `launch::collect_instadex_fees` on every Instadex lock with accrued LP fees. Burns coin A, splits quote 60/10/30. |

HTTP cron routes require `Authorization: Bearer $CRON_SECRET` (Vercel Cron sends this). The CLI (`npx tsx src/cli.ts …`) does not.

Local:

```
ARENA_PACKAGE_ID=0x... npx tsx src/cli.ts reflections
ARENA_KEEPER_PHRASE='…' npx tsx src/cli.ts collect
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

Gold quote type: `0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM`

Snapshot file (default `./data/reflections.json`) is the shape the token page can read for unpaid quote.

## Env

- `ARENA_PACKAGE_ID`=`0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`
- `SUI_RPC`
- `ARENA_PIT_SUI`=`0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`
- `ARENA_PIT_XAUM`=`0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783`
- `ARENA_CONFIG`=`0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`
- `ARENA_KEEPER_PHRASE` optional. If unset, collect/ring/settle sign with the local Sui keystore (gas only, not AdminCap).
- `CRON_SECRET` required on Vercel so `/api/{ring,settle,collect,reflections}` are not public.
- `ARENA_CALL_PACKAGE` (latest published-at, default v7 `0x5175…`)
- `ARENA_INSTADEX_PACKAGE` (InstadexLaunchEvent type origin v4 `0xcf78…`)
- `SUI_GRAPHQL` (default `https://graphql.mainnet.sui.io/graphql`)
- Platform launch + swap-fee withdraws: Odyssey admin `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b` holds `AdminCap`
- `KEEPERS_CURSOR_PATH`
