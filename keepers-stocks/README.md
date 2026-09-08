# Arena keepers-stocks

RH -> Sui wrap attestor for The Arena.

See `src/` for mint CLI, RH vault watcher (auto-mint), and webhook acceptor.
Contract ids: `../contracts-stocks/PUBLISHED.md`.
RH lock vault: `../rh-vault/` (`StockLockVault.sol`, `PUBLISHED.md`).

## v1 flow

1. User on RH Chain: `approve(vault)` + `deposit(token, amount, suiRecipient bytes32)`.
2. Vault emits `DepositLocked` -> **watcher polls, maps token->ticker, calls `bridge::mint`**.
3. Pad shows wrap balance after Sui `MintedEvent`.
4. Burn on Sui emits `RedeemBurned` -> RELEASER calls `vault.release(depositId, to)`.

## Operator: RH watcher -> auto-mint

Run from `keepers-stocks/` with the **MinterCap holder** wallet
(`0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`).
Do **not** transfer MinterCaps off that address.

Use package scripts `watch-rh` / `mint`. Provide the MinterCap holder signer via
keeper phrase env or local Sui keystore. Never print or commit private keys.

Defaults:
- RH_RPC = https://rpc.mainnet.chain.robinhood.com
- RH_VAULT_ADDRESS = 0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058

Dry-run once (no live mint):
  STOCKS_MINT_DRY_RUN=1 RH_WATCH_LOOKBACK=2000 npx tsx src/cli.ts watch-rh

Continuous live operator loop:
  RH_WATCH_LOOP=1 RH_WATCH_POLL_MS=15000 npx tsx src/cli.ts watch-rh
  (omit STOCKS_MINT_DRY_RUN; requires MinterCap signer)

### Modes

| Mode | How |
|------|-----|
| Once then exit | default (RH_WATCH_LOOP unset) |
| Continuous | RH_WATCH_LOOP=1 |
| Dry-run mint | STOCKS_MINT_DRY_RUN=1 (or --dry-run on mint CLI) |
| Live mint | dry-run unset + MinterCap signer present |

DepositLocked topic0 (verified): 0xcd369024a239038366adb9f97aeb7dc8fd7b4b4ff5aeeaf4d0717a8d4a5e0c6d

Each event becomes a mint with:
- recipient: suiRecipient bytes32 -> 0x + 64 hex Sui address
- amount: RH 18-dec base units passed through (same 18-dec on Sui wrap)
- rh_ref: {txHash}:{depositId} (local + on-chain dedupe)

### Manual mint CLI

  npx tsx src/cli.ts mint --ticker NVDA --amount <18dec> --recipient 0x... --rh-ref <tx|id> [--dry-run]
  npx tsx src/cli.ts webhook

## Dedupe

rh_ref local log (data/minted-refs.json) plus MintedEvent scan prevents double mint.

## Caveats

- u64 limit: Sui bridge::mint takes u64. RH uint256 amounts above 2^64-1
  (~18.44 whole tokens at 18 decimals) are skipped with an error log. Split deposits
  under that cap until the Move API supports larger amounts.
- Key custody: keep keeper phrase / keystore only on the operator host;
  never print or commit keys. MinterCaps must stay on the publisher address.
- Lookback: first poll re-scans RH_WATCH_LOOKBACK blocks and will attempt mint
  for each unmatched DepositLocked - start with STOCKS_MINT_DRY_RUN=1 or a small
  lookback / RH_WATCH_FROM_BLOCK near tip when bringing a live operator online.
- Prefer dry-run when validating. No Move publish from keepers.

## Env cheat-sheet

SUI_RPC, ARENA_STOCKS_PACKAGE, ARENA_KEEPER_PHRASE, ARENA_KEEPER_ADDRESS,
STOCKS_MINT_DRY_RUN, STOCKS_DATA_DIR, STOCKS_MINT_SECRET, STOCKS_WEBHOOK_PORT,
RH_RPC, RH_VAULT_ADDRESS, RH_WATCH_LOOP, RH_WATCH_POLL_MS, RH_WATCH_LOOKBACK,
RH_WATCH_FROM_BLOCK.
