# Arena keepers-stocks

RH -> Sui wrap attestor for The Arena.

See `src/` for mint CLI, RH vault watcher (auto-mint), and webhook acceptor.
Contract ids: `../contracts-stocks/PUBLISHED.md`.
RH lock vault: `../rh-vault/` (`StockLockVault.sol`, `PUBLISHED.md`).

## v1 flow

1. User on RH Chain: `approve(vault)` + `deposit(token, amount, suiRecipient bytes32)`.
2. Vault emits `DepositLocked` -> **watcher polls, maps token->ticker, calls `bridge::mint`**.
3. Pad shows wrap balance after Sui `MintedEvent`.
4. Burn on Sui emits `RedeemBurned` (includes `rh_dest`, a 20-byte EVM address).
   `watch-redeem` FIFO-matches the burn against unreleased RH locks and
   **dry-runs** `vault.release(depositId, rh_dest)` by default. Live broadcast
   is opt-in (`--live` / `STOCKS_RELEASE_LIVE=1` + `RH_RELEASER_KEY`).

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
- amount: RH 18dp / 1e9 → Sui 9dp wrapper units (`RH_TO_SUI_SCALE`)
- rh_ref: {txHash}:{depositId} (local + on-chain + vault `minted` table)

## Operator: RedeemBurned → RH release

Sui wrappers are fungible. `RedeemBurned` carries `{ticker, amount, burner, rh_dest}`
and **no depositId**. `StockLockVault.release(depositId, to)` is all-or-nothing
per lock. The watcher therefore:

1. Loads every lock via `nextDepositId` + `getLock` (chain is source of truth).
2. FIFO-matches oldest unreleased locks of that token whose Sui-equivalent
   (`floor(rhAmount / 1e9)`) fits in the remaining burn.
3. Plans `release(depositId, rh_dest)` on each **fully consumed** lock.
4. **Flags a `MISMATCH`** and does not take a lock that would over-release
   (next lock larger than leftover) or leave a leftover that no remaining
   lock can cover. Partial prefix releases are logged as `partial`.
5. Persists the plan / txs in `data/redeemed.json` (same idea as
   `minted-refs.json`) so a restart will not double-release.

Dry-run once (default — **does not send**):

```bash
npx tsx src/cli.ts watch-redeem
```

Continuous dry-run:

```bash
RH_REDEEM_LOOP=1 npx tsx src/cli.ts watch-redeem
```

Live broadcast (moves real RH stock tokens; requires the RELEASER key):

```bash
STOCKS_RELEASE_LIVE=1 RH_RELEASER_KEY=… npx tsx src/cli.ts watch-redeem --live
```

Never print or commit `RH_RELEASER_KEY`. Dry-run `eth_call`s `release()` from
`RH_RELEASER_ADDRESS` (default `0xDE0d5aea…19bc`) to show whether the tx would
revert. Live signing uses the in-process key — the key is not passed on a
child argv.

### Matching examples

| Burn (Sui 9dp) | Outstanding locks (oldest first) | Result |
|----------------|----------------------------------|--------|
| 10 | 10 | exact, release #1 |
| 10 | 4, 6 | exact, release #1 then #2 |
| 5 | 10 | `MISMATCH` unmatched — would over-release |
| 10 | 4, 7 | partial: release #1 (4), flag leftover 6 vs lock #2=7 |

### Contract-change proposal (not in this PR)

Per-deposit `release()` cannot pay a burn of 5 out of a lock of 10, or a burn
that is not a FIFO prefix of whole deposits (user merged coins, burned a
slice). A pooled model would:

```solidity
function releaseAmount(address token, uint256 amount, address to)
    external onlyRole(RELEASER_ROLE);
```

Internally FIFO-consume locks of `token`, allow a remainder on the last lock
(split: mark original released, insert a smaller leftover lock, or keep a
`remaining` field). That matches fungible Sui burns 1:1 without a watcher
heuristic. **Do not silently redeploy `StockLockVault`** — this is a proposal;
the live vault at `0xB0DbeA…c058` stays as-is.

Until then, operators must treat `MISMATCH` lines as a human ticket: either
wait for more burns that exact-match remaining locks, or release manually.

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
RH_WATCH_FROM_BLOCK,
RH_REDEEM_LOOP, RH_REDEEM_POLL_MS, STOCKS_RELEASE_LIVE, RH_RELEASER_KEY,
RH_RELEASER_ADDRESS.
