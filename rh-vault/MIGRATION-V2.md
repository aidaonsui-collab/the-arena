# StockLockVault → StockLockVaultV2 migration

Why: v1's `release(depositId, to)` pays **whole deposits only**, so a Sui burn
that isn't an exact FIFO prefix-sum of unreleased locks can't be paid in full.
`bridge::burn` destroys the wrapper unconditionally, so the shortfall was simply
lost by the redeemer, and the keeper never retried it. v2 pays any amount out of
pooled backing.

**Nothing in this document has been broadcast.** Every step is for the operator
holding the admin / releaser keys.

## Addresses

| What | Address |
|------|---------|
| v1 vault (live) | `0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058` |
| v1 admin + releaser | `0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc` |
| v2 vault | _(filled in after step 1)_ |
| RH chain | 4663 · `https://rpc.mainnet.chain.robinhood.com` |

## State to migrate (verified 2026-09-16)

| Ticker | Token | v1 lock | RH amount (18dp) | Sui wrapper supply (9dp) |
|--------|-------|---------|------------------|--------------------------|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` | #3 | `467630231347460427` | `467630231` |
| AMC | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` | #4 | `41827970112180698388` | `41827970112` |

Locks #1 and #2 are already released. GME and TSLA have no supply and no locks.

Note the RH side holds slightly **more** than the wrapper claims — `347460427`
wei NVDA and `180698388` wei AMC of mint-side rounding dust (a lock mints
`floor(amount / 1e9)`). v2 ends up marginally over-collateralised, which is the
safe direction. Do not "correct" it.

## Steps

### 1. Deploy v2, paused

```bash
export PATH="$HOME/.foundry/bin:$PATH"
cd rh-vault
export PRIVATE_KEY=0x…            # deployer
export ADMIN=0x…                  # ideally a multisig (audit H-4)
export RELEASER=0x…               # keeper releaser
export GUARDIAN=0x…               # pause-only, can differ from admin
export MIGRATE=1                  # deploy paused

forge script script/DeployV2.s.sol:DeployV2 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com \
  --broadcast --chain-id 4663
```

Record the printed `StockLockVaultV2` address as `$V2`.

### 2. Stop new v1 deposits

v1 has no pause (audit M-2). Cut deposits off at the edge instead:

- point `window.ARENA_RH_VAULT` in `index.html` at `$V2` (step 5), and
- revoke v1's allowlist so late direct callers revert:

```bash
cast send 0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058 \
  "setTokensAllowed(address[],bool)" \
  "[0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC,0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B,0x1b0E319c6A659F002271B69dB8A7df2F911c153E,0x322F0929c4625eD5bAd873c95208D54E1c003b2d]" \
  false \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663
```

`release` deliberately does not check the allowlist, so step 3 still works.

### 3. Move collateral v1 → v2

Release each outstanding v1 lock **to the v2 vault address**:

```bash
cast send 0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058 \
  "release(uint256,address)" 3 $V2 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663

cast send 0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058 \
  "release(uint256,address)" 4 $V2 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663
```

Verify the balances landed before continuing:

```bash
cast call 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC "balanceOf(address)(uint256)" $V2 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com   # expect 467630231347460427
cast call 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B "balanceOf(address)(uint256)" $V2 \
  --rpc-url https://rpc.mainnet.chain.robinhood.com   # expect 41827970112180698388
```

### 4. Reconcile backing (must be paused)

Migrated collateral arrives without a `deposit()`, so `totalLocked` is still 0
and nothing is redeemable until it is synced:

```bash
for T in 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC 0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B; do
  cast send $V2 "syncBacking(address)" $T \
    --rpc-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663
done

# confirm
cast call $V2 "backingOf(address)(uint256)" 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC \
  --rpc-url https://rpc.mainnet.chain.robinhood.com
```

`syncBacking` reverts unless the vault is paused — that is intentional, so it
can never race a live release.

### 5. Repoint frontend and keeper

- `index.html`: `window.ARENA_RH_VAULT = "$V2"`.
  No other frontend change is needed — the redeem preflight detects a pooled
  vault by calling `backingOf(address)` and automatically drops the v1
  exact-match restriction (v1 reverts on that selector; v2 answers).
- `keepers-stocks/src/config.ts`: `DEFAULT_RH_VAULT_ADDRESS = "$V2"`.
- Keeper release path: switch `redeemWatcher` from `matchFifo` + `sendRelease`
  to `sendReleaseV2({ token, amount: burnAmount * 1e9, to: rhDest, suiBurnRefHex: suiBurnRef(digest, eventSeq) })`.
  The FIFO matcher is no longer needed: every burn is payable up to `backingOf`.

### 6. Unpause

```bash
cast send $V2 "unpause()" \
  --rpc-url https://rpc.mainnet.chain.robinhood.com --chain-id 4663
```

### 7. Post-migration checks

```bash
cast call $V2 "paused()(bool)" --rpc-url …            # false
cast call $V2 "backingOf(address)(uint256)" <token>   # matches balanceOf
cast call $V2 "hasRole(bytes32,address)(bool)" \
  $(cast keccak "RELEASER_ROLE") <keeper>             # true
```

Then confirm per ticker that `backingOf(token) >= wrapperSupply * 1e9`:

| Ticker | Required backing (wei) |
|--------|------------------------|
| NVDA | `467630231000000000` |
| AMC | `41827970112000000000` |

## What this migration does and does not fix

Fixes, from the audit:
- **C-1** — redemption is amount-based, so any burn is payable.
- **H-2 / H-3** — `sendReleaseV2` waits for the receipt and takes nonces from a
  sequencer; on-chain `settledBurns[suiBurnRef]` makes a retry idempotent, so
  the keeper's local store is no longer the only replay guard.
- **M-2** — `pause()` (guardian can pause, admin-only unpause).
- **M-4** — deposits record the observed balance delta, not the requested amount.

Still open after this:
- **H-1** — the mint watcher still reads to chain tip with no confirmation depth.
- **H-4** — releaser can still pay an arbitrary `to`; put it behind a multisig,
  and consider a per-window release cap.
- **H-5** — MinterCap still shares the Arena platform key.
- **M-1** — keeper still trusts one RPC and does not verify `log.address`.
- **M-3** — `listLocks` still enumerates every deposit per poll (only used by the
  v1 path; it disappears with the FIFO matcher).
