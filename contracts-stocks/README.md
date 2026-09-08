# Arena stocks — Robinhood Chain → Sui 1:1 wrap

Separate Move package (`stocks`) so stock wrappers do **not** force an Arena (`arena`) Compatible upgrade.

## Product

Users buy RH stock tokens on the **Robinhood Chain secondary market**. Arena’s bridge:

1. **Locks** those tokens in an RH-side vault (off-chain for v1).
2. **Mints** matching Sui wrappers 1:1 (`stocks::nvda::NVDA`, etc.).
3. On **burn** of the Sui wrapper, emits `RedeemBurned`; off-chain releases the RH vault.

This is **not** Robinhood primary AP mint. Pad Bridge UI already scaffolds tickers; RH NVDA = `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC`. Wrappers are intended as Instadex quote coins later.

## Modules

| Module | Role |
|--------|------|
| `stocks::nvda` / `amc` / `gme` / `tsla` | Coin types, 18 decimals, symbol = ticker, name `Arena Wrapped <TICKER>`. `init` creates currency, shares `BridgeVault<T>`, transfers `MinterCap` to publisher. |
| `stocks::bridge` | `BridgeVault<T>` (shared, holds `TreasuryCap<T>`), `MinterCap` (`key` + `store`, bound to vault id), `mint` / `burn`, events. |

### Design

- `BridgeVault<T>` — shared object holding the sole `TreasuryCap<T>` and ticker bytes.
- `MinterCap` — required for `mint`; `vault_id` must match the vault or mint aborts `EUnauthorized`.
- `mint(vault, minter, amount, recipient, rh_ref, ctx)` — mints to `recipient`, emits `MintedEvent` with type name, ticker, amount, recipient, opaque `rh_ref` (RH lock attestation).
- `burn(vault, coin, ctx)` — burns coin, emits `RedeemBurned` for the release watcher.

RH vault custody is **off-chain in v1**; on-chain only tracks Sui supply + attestation refs in events.

## Build / test

```bash
# prefer /tmp/sui-cli/extract/sui or /workspace/sui (1.78+)
sui move test
sui move build
```

Do **not** publish from this scaffold task until addresses and keeper ops are ready. First publish uses `stocks = "0x0"`.

## Bridge UI / Arena integration

After publish, wire Pad Bridge placeholders to:

1. **Package / coin types** — e.g. `<PACKAGE>::nvda::NVDA` (and amc/gme/tsla).
2. **Shared `BridgeVault<T>` object id** per ticker (from publish tx effects).
3. **`MinterCap` holder** — platform / keeper wallet that attested the RH lock; only this cap can call `mint`.
4. **Events to index**
   - `stocks::bridge::MintedEvent` — confirm mint after RH lock.
   - `stocks::bridge::RedeemBurned` — trigger RH vault release.
5. User redeem path: PTB `burn` with user’s `Coin<T>` + shared vault (no MinterCap).

Never import `arena::bluefin` from this package.
