# Arena keepers-stocks

RH to Sui wrap attestor for The Arena.

See src/ for mint CLI, rh watcher stub, and webhook acceptor.
Contract ids live in ../contracts-stocks/PUBLISHED.md.

## v1 flow
RH vault is OFF-CHAIN for v1.
Operator runs the mint CLI after an RH lock.
Pad shows balance after MintedEvent; burn emits RedeemBurned.
## Run
CLI: npx tsx src/cli.ts mint
Also watch-rh and webhook subcommands

## Dedupe
rh_ref local log plus MintedEvent scan prevents double mint

## Pad lock-and-wait
Show pending until MintedEvent then refresh wrap balance
CTA already says lock on RH mint is automatic

## Safety
Prefer dry-run. Do not transfer MinterCaps. No Move publish.

Env: SUI_RPC, ARENA_STOCKS_PACKAGE, ARENA_KEEPER_PHRASE, STOCKS_MINT_DRY_RUN,
STOCKS_DATA_DIR, STOCKS_MINT_SECRET, STOCKS_WEBHOOK_PORT, RH_RPC, RH_VAULT_ADDRESS.
Ids: see ../contracts-stocks/PUBLISHED.md
