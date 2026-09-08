> **Stale — needs republish.** The package below is 18-decimal and has no
> on-chain replay guard. Both are fixed in source; the ids here are from the
> superseded publish and must be regenerated. Safe to replace: `nextDepositId`
> on the RH vault is still 1 (no deposits ever), and the only mint was the
> `smoke-2026-09-08-nvda-001` test, burned the same day, so supply is zero and
> there is nothing to migrate.
>
> After republishing, update every id here plus `keepers-stocks/src/config.ts`
> and the frontend `STOCKS` config.

# Mainnet — stocks (RH → Sui wrap)

Published from `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b` (elegant-tourmaline).

- **Package / type origin**: `0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db`
- **Publish tx**: `BTaWMYoGiLk8WUHZQY1okrzpKA2VWNoFmiGP2imZ38z9` (2026-09-08 ~08:20 CT)
- **UpgradeCap**: `0x8686fbfca47fd97a4c5a29162738aff86b776b59dc66976ff0e8aa5f3cb5a3cf` (held by publisher)

## Coin types

| Ticker | Type |
|--------|------|
| NVDA | `0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db::nvda::NVDA` |
| AMC | `0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db::amc::AMC` |
| GME | `0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db::gme::GME` |
| TSLA | `0x0f01d0b041f98c02a29c8d1efffd03d60db42b3a20f5899ff5e0f663f0ea09db::tsla::TSLA` |

## BridgeVault (shared)

| Ticker | BridgeVault object id |
|--------|------------------------|
| NVDA | `0xc221abc5c9f94ae90cb02db643ffa532db5944afac3d1d5006a74987dc52727d` |
| AMC | `0xb2b480f907479831aedb115fa1f10e0acc81f00a5f44bab0507358e431ae22cf` |
| GME | `0xc743951e4330499438635579a2049b28af65068fb9d5c4af3e5618229ac6cfa2` |
| TSLA | `0xef39c0154e56c5c4159aa0dd12332d48f8f8c843142787a7d4dbd59b0587a4c5` |

Initial shared version: `994014475`.

## MinterCap (AddressOwner = publisher)

| Ticker | MinterCap object id | Bound vault_id |
|--------|---------------------|----------------|
| NVDA | `0x13e05950b45c5dff193b22e9d1da79fc1fe206faf38d46352dfbd63e2e2630f8` | NVDA vault above |
| AMC | `0x4b264731e6ad60edf571d4c841f8a5c8113d6508d587f4e153869d52a535410e` | AMC vault above |
| GME | `0xbcbb7c683fe1148a6432c83152516bc86268f8e89d56caab130b663a88dbd342` | GME vault above |
| TSLA | `0x5661c3f1b77d8ac2facb9bbbf48b1010a6c77ab3f5b55945e9b53295a866ac13` | TSLA vault above |

All four caps held by `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.

## CoinMetadata (immutable)

| Ticker | CoinMetadata object id |
|--------|------------------------|
| NVDA | `0xdc869b6282ec456089b68c92fab602054bb6315602b08f4664b204f5bdd60683` |
| AMC | `0x06a18ab1fa5f6170b46752cfdec7739b609cb35adadfcc18d5f57d23c00625ac` |
| GME | `0x81cc6fd95c21880cfae8d73e089ed1ea6d40ccbe2500c4bc0c1c4e125e3e8bfe` |
| TSLA | `0x63f7e1a16f8fa1b2289f662692b09105ef7bd9e7d5867980597ec9af9e02b74e` |

## Events

- `0x0f01…::bridge::MintedEvent`
- `0x0f01…::bridge::RedeemBurned`
