# StockLockVault — published (RH Chain mainnet)

## Live: StockLockVaultV2

Pooled, amount-based redemption. v1 could only pay whole deposits, so a burn
that was not an exact FIFO prefix-sum of unreleased locks could not be paid in
full — and `bridge::burn` had already destroyed the wrapper. v2 pays any amount
against pooled backing.

| Field | Value |
|-------|-------|
| Network | Robinhood Chain mainnet |
| chainId | `4663` |
| `RH_VAULT_ADDRESS` / StockLockVaultV2 | [`0x3870b3B4767bf96C88828A992448cCf55530f0c9`](https://robinhoodchain.blockscout.com/address/0x3870b3B4767bf96C88828A992448cCf55530f0c9) |
| Admin + releaser + guardian | `0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc` |
| RPC | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | https://robinhoodchain.blockscout.com |

All four stock tokens are allowlisted on v2, it is unpaused, and backing matches
holdings exactly (verified on-chain — see below).

> **Open risk.** All three roles sit on one EOA. `GUARDIAN_ROLE` exists so a
> separate key can trip the circuit breaker without holding spending power;
> granting it to the releaser defeats that. Splitting the releaser onto a
> multisig and the guardian onto a distinct key is audit item H-4 and is still
> outstanding.

## Retired: StockLockVault (v1)

| Field | Value |
|-------|-------|
| Address | [`0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058`](https://robinhoodchain.blockscout.com/address/0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058) |
| Create tx | [`0x971feabc20d09c63cbb738226a234aa48f48aad84dc094b2b99cc02b2e95d27d`](https://robinhoodchain.blockscout.com/tx/0x971feabc20d09c63cbb738226a234aa48f48aad84dc094b2b99cc02b2e95d27d) |
| Allowlist tx (`setTokensAllowed`) | [`0x52ed7aa71fddb7637014171dda360bcd3511bebc69f2d8b0f27c3815d87cde1d`](https://robinhoodchain.blockscout.com/tx/0x52ed7aa71fddb7637014171dda360bcd3511bebc69f2d8b0f27c3815d87cde1d) |
| Status | Drained and delisted — all four tokens `allowedTokens=false`, so `deposit` reverts. Balances zero, locks #1–#4 all released. |

Do not point anything at v1. It holds nothing and accepts nothing.

## Migration (executed)

v1 locks #3 and #4 were released into v2, then `syncBacking` counted them:

| Ticker | Migrated from v1 | v2 `backingOf` | v2 `balanceOf` | Sui wrapper supply (9dp) | Required backing |
|--------|------------------|----------------|----------------|--------------------------|------------------|
| NVDA | `467630231347460427` (lock #3) | `517693178413062785` | `517693178413062785` | `517693178` | `517693178000000000` |
| AMC | `41827970112180698388` (lock #4) | `41827970112180698388` | `41827970112180698388` | `41827970112` | `41827970112000000000` |
| GME | — | `0` | `0` | `0` | `0` |
| TSLA | — | `0` | `0` | `0` | `0` |

Backing equals holdings on every token, and exceeds the wrapper supply's
requirement on both live tickers — the difference is mint-side rounding dust
(a lock mints `floor(amount / 1e9)`), which leaves v2 marginally
over-collateralised. That is the safe direction; do not "correct" it.

NVDA backing exceeds the migrated lock because a `0.050062947065602358` NVDA
deposit was made through v2 after migration and minted successfully on Sui,
which is what raised the wrapper supply from `467630231` to `517693178`.

## Allowlisted stock tokens

| Ticker | Address |
|--------|---------|
| NVDA | `0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC` |
| AMC | `0x05a3d1Cd21d0C88145E82600E62e7E496e0F222B` |
| GME | `0x1b0E319c6A659F002271B69dB8A7df2F911c153E` |
| TSLA | `0x322F0929c4625eD5bAd873c95208D54E1c003b2d` |

## Keeper env

```bash
export RH_RPC=https://rpc.mainnet.chain.robinhood.com
export RH_VAULT_ADDRESS=0x3870b3B4767bf96C88828A992448cCf55530f0c9
```
