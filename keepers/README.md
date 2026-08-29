# Arena keepers

Cron jobs for The Arena launchpad. Reflection payouts **accrue on every fill** in Move (`pool::buy` / `pool::sell`). Keepers do not push SUI/XAUM to wallets (the holder table is not iterable). They index, and they ring/settle the pit.

## Jobs

| Cron | Path | What |
| --- | --- | --- |
| `* * * * *` | `/api/reflections` | Ingest `TradeEvent` + `ClaimEvent` (kind=0). Snapshot unpaid/claimed per holder. |
| `*/5 * * * *` | `/api/ring` | Call `pit::ring` when the round clock is up. |
| `*/5 * * * *` | `/api/settle` | Call `pool::settle_pit` on the winning pool after `BellEvent`. |

Local:

```
ARENA_PACKAGE_ID=0x... npx tsx src/cli.ts reflections
```

## Events for the UI indexer

Package `P`. Subscribe:

- `P::events::TradeEvent` — candles, tape, `pit_fee`, `reflection_fee`, `creator_fee`, `platform_fee` (reflection fills include a pit cut)
- `P::events::ClaimEvent` — `kind=0` reflection, `kind=1` pit, `kind=2` creator
- `P::events::LaunchEvent` — `reflection: bool`, quote type
- `P::events::BellEvent` / `PitSettleEvent` / `PitNudgeEvent`
- `P::events::GraduationEvent`
- `P::events::LockEvent` / `LpClaimEvent` — graduated LP time vault

Gold quote type: `0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM`

Snapshot file (default `./data/reflections.json`) is the shape the token page can read for unpaid quote.

## Env

- `ARENA_PACKAGE_ID`
- `SUI_RPC`
- `ARENA_PIT_SUI` / `ARENA_PIT_XAUM` (shared object ids after publish)
- `ARENA_KEEPER_PHRASE` (signing key for ring/settle, later — not the platform wallet)
- Platform launch + swap-fee withdraws: Odyssey admin `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b` holds `AdminCap`
- `KEEPERS_CURSOR_PATH`
