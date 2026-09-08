# Arena keepers-stocks

RH → Sui wrap attestor for The Arena.

See `src/` for mint CLI, RH vault watcher, and webhook acceptor.
Contract ids: `../contracts-stocks/PUBLISHED.md`.
RH lock vault: `../rh-vault/` (`StockLockVault.sol`).

## v1 flow

1. User on RH Chain: `approve(vault)` + `deposit(token, amount, suiRecipient bytes32)`.
2. Vault emits `DepositLocked` → watcher polls / logs.
3. Operator runs mint CLI (or future auto-enqueue) with `rh_tx_hash` / depositId.
4. Pad shows wrap balance after Sui `MintedEvent`.
5. Burn on Sui emits `RedeemBurned` → RELEASER calls `vault.release(depositId, to)`.

## Run

```bash
npx tsx src/cli.ts mint --ticker NVDA --amount <18dec> --recipient 0x… --rh-ref <tx|id> [--dry-run]
npx tsx src/cli.ts watch-rh
npx tsx src/cli.ts webhook
```

### RH watcher

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_VAULT_ADDRESS=0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058  # StockLockVault (RH mainnet 4663)
# optional: RH_WATCH_POLL_MS=15000 RH_WATCH_LOOKBACK=2000 RH_WATCH_LOOP=1
npx tsx src/cli.ts watch-rh
```

`DepositLocked` topic0: `0xcd369024a239038366adb9f97aeb7dc8fd7b4b4ff5aeeaf4d0717a8d4a5e0c6d`

## Dedupe

`rh_ref` local log plus `MintedEvent` scan prevents double mint.

## Safety

Prefer dry-run. Do not transfer MinterCaps. No Move publish from keepers.

Env: `SUI_RPC`, `ARENA_STOCKS_PACKAGE`, `ARENA_KEEPER_PHRASE`, `STOCKS_MINT_DRY_RUN`,
`STOCKS_DATA_DIR`, `STOCKS_MINT_SECRET`, `STOCKS_WEBHOOK_PORT`, `RH_RPC`, `RH_VAULT_ADDRESS`.
