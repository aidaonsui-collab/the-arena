# Arena Move package

Fair launches on Sui. Bonding curve, no presale.

## Three launch modes

1. **TOKEN/SUI** — curve quoted in SUI. Graduation at 2,000 SUI.
2. **TOKEN/XAUM** — same curve, quoted in Matrixdock gold. Bluefin Spot lists this as **XAUM**, not GOLD.
3. **Reflection** — same 1% swap fee, split 50/20/20/10 reflections/creator/pit/platform.

## Gold quote is XAUM

Bluefin ticker: `XAUM` (Matrixdock Gold, 1 token = 1 troy oz LBMA gold).

```
0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM
```

9 decimals. Bluefin Spot pools: XAUM/SUI, XAUM/USDC.

The package does not vendor Matrixdock sources. `Pool<T, Q>` and `Pit<Q>` are generic; pass XAUM as `Q` at the call site.

`Pit<SUI>` is created at publish. After publish, open the gold pit once:

```
sui client call --package <ARENA> --module pit --function create_pit \
  --type-args 0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM
```

Graduation for XAUM defaults to **1 XAUM** (not 2,000 units). 2,000 SUI is only ~0.3 oz.

## Fees and the pit

- Launch fee: 1 SUI, even for XAUM pairs. Accrues in `Config.treasury`.
- Platform cut (10% of the 1% swap fee) accrues in `Config.platform`. Both that bag and the launch treasury are withdrawn with `AdminCap`, which init sends to Odyssey's platform wallet `0x2957f0f19ee92eb5283bf1aa6ce7a3742ea7bc79bc9d1dc907fbbf7a11567409`.
- 1% (`swap_fee_bps=100`) of every fill (buy quote in, sell quote out).
  - Standard: 60% creator, 10% platform, 30% pit.
  - Reflection: 50% holders, 25% creator, 25% platform, 0 pit.
- Highest cap still on the curve when the bell rings wins.
  - Holders: pot is claimable pro-rata via the holder registry.
  - Buy and burn: pot buys the winning token on the curve and burns it.

## Launch (two transactions)

1. Publish a coin module so you have `TreasuryCap<T>` + `CoinMetadata<T>`.
2. Call `launch::launch<T, Q>` with 1 SUI, pit mode (`0` holders / `1` buy-and-burn), and the reflection flag.

## Graduation

Trading freezes when `raised` hits the quote threshold. Call `lock::lock_graduated_lp` to vault remaining reserves for `lp_lock_ms` (180 days) to the creator. Stand-in until DeepBook LP (no hardcoded package IDs).

## Holder registry

Sui coins have no transfer hooks. Reflections and pit-holder claims follow **net bought through the pool**. Sending `Coin<T>` elsewhere does not move the registry.

## Build / test

```
sui move build
sui move test
```
