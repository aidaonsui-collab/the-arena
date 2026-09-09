# Mainnet — stocks (RH → Sui wrap)

Published from `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b` (elegant-tourmaline).

- **Package / type origin**: `0x9a4ba3338384d36033065f9cf0c58078033a718a92f091f12a551f6984c290c5`
- **Publish tx**: `CLF3jgp39FCMh7KjvGqjWULcQXvju9f86qFbJaNPvL13` (2026-09-09)
- **UpgradeCap**: `0xd6abd757cf385b03aea32a8118d6ae3ea1731de8b9787e27bd3b692e1db68177` (held by publisher)
- Fresh publish, not an upgrade of `0x0f01d0b0…09db` — `BridgeVault` gained a
  `minted` table, `RedeemBurned` gained `rh_dest`, and `burn()` gained a
  parameter, none of which is upgrade-compatible. Confirmed on-chain against
  the module ABI: `burn` takes `(vault, coin, rh_dest, ctx)`, `BridgeVault`
  has `{id, treasury, ticker, minted}`, `RedeemBurned` has
  `{coin_type, ticker, amount, burner, rh_dest}`, and every `CoinMetadata`
  reports 9 decimals.

## Coin types

| Ticker | Type |
|--------|------|
| NVDA | `0x9a4ba3338384d36033065f9cf0c58078033a718a92f091f12a551f6984c290c5::nvda::NVDA` |
| AMC | `0x9a4ba3338384d36033065f9cf0c58078033a718a92f091f12a551f6984c290c5::amc::AMC` |
| GME | `0x9a4ba3338384d36033065f9cf0c58078033a718a92f091f12a551f6984c290c5::gme::GME` |
| TSLA | `0x9a4ba3338384d36033065f9cf0c58078033a718a92f091f12a551f6984c290c5::tsla::TSLA` |

## BridgeVault (shared)

| Ticker | BridgeVault object id |
|--------|------------------------|
| NVDA | `0xf6a8f80cf7d75f7e9e83712d10722b9f5302eaaf585ee6c149497379b8647bbc` |
| AMC | `0x091bb1a2da97f685c19c607d71fe2bd1b9e5198768bac3d8898562802b739f61` |
| GME | `0x6f832d8b04c1e59863cd37a9191554f9fc3654e85e5ae06520d495f761afa680` |
| TSLA | `0xc91e4691e2df8cd6cfee17356687b2387fe26fa81793d6fd8cd4c52afd489b65` |

Initial shared version: `995269128`.

## MinterCap (AddressOwner = publisher)

| Ticker | MinterCap object id | Bound vault_id |
|--------|---------------------|----------------|
| NVDA | `0x5fd6af65b81cd8582eb9864f5ab0378270bd621cfc92de994b1a86d9fcb3fc02` | NVDA vault above |
| AMC | `0x54a3b56fd06994726716e1df74834c6736e6dd907d22ef601f0e773fb3de6417` | AMC vault above |
| GME | `0x77c8cf4185f0a3cc098f1ab9bd96674d454ef822d8ba69ac739c77662d9da90d` | GME vault above |
| TSLA | `0x7f6f580c1232d1474b9c09e755bdf2f0b468b7e7b6d69ffd4d77bc4a7c0d955e` | TSLA vault above |

All four caps held by `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.

## CoinMetadata (immutable, 9 decimals)

| Ticker | CoinMetadata object id |
|--------|------------------------|
| NVDA | `0x516c4a864e787ac6a0ba5c0daef5ec3149dd2b47d59fbe1b556aadf81415e24b` |
| AMC | `0x10c505d214b92e25fb2b93dff0cf303ec6799a915c521bf525f18a496f6882a2` |
| GME | `0x4837967923626e9b625c33a119166638d4668fe500a4f4ed0d2bb20abfa7f54a` |
| TSLA | `0xe088b2a8e8b87df689d09cc0dfdea9eb62e1d49fac83a9420fbe36a509077943` |

## Events

- `0x9a4b…290c5::bridge::MintedEvent`
- `0x9a4b…290c5::bridge::RedeemBurned` — now carries `rh_dest` (20-byte EVM
  address), the RH release destination the burner supplied.

## Superseded packages

- `0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db` — the
  original publish. 18-decimal, no replay guard, no `rh_dest`. Frontend/keeper
  no longer point at this. Its one real mint (4.947270614360234872 AMC) was
  burned back and released on RH Chain (deposit #1) before this republish, so
  nothing is stranded on it.
- `0x8b9bd78012ced409f111e227b01c94a30756e9e1b5671e0b96894077195cbdaf` — an
  in-between publish from a stale checkout that still had the old,
  pre-`rh_dest`/pre-decimals-fix source. Confirmed via its module ABI. Never
  wired into any config; inert, nothing references it, safe to ignore.
