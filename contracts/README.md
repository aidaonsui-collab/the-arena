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
- Platform cut (10% of the 1% swap fee) accrues in `Config.platform`. Both that bag and the launch treasury are withdrawn with `AdminCap`, which init sends to Odyssey's platform wallet `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.
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

Trading freezes when `raised` hits the quote threshold. Production then seeds a Bluefin Spot pool and time-locks the Position NFT:

**SUI quote PTB** — `lock::seed_and_lock_bluefin<T>`:

| Arg | Object |
| --- | --- |
| `pool` | graduated `Pool<T, SUI>` |
| `config` | Arena `Config` |
| `clock` | `0x6` |
| `bf_config` | Bluefin `GlobalConfig` `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352` |
| `meta_t` | `CoinMetadata<T>` |
| `meta_q` | `CoinMetadata<SUI>` |

Creation fee is taken from `quote_reserve` (aborts if short). No extra SUI coin.

**XAUM quote PTB** — `lock::seed_and_lock_bluefin_with_fee<T, XAUM>`: same objects plus an extra `Coin<SUI>` paying Bluefin's pool-creation fee. Residuals from the seed go to the pool creator, not the platform.

The Bluefin pool is named `SYM-SUI` / `SYM-XAUM`, fee 1% (`fee_rate=10_000` in 1e6), tick spacing 60, full-range ticks snapped from GlobalConfig min/max (`−443636` / `443636` bits `4294523660` / `443636`) inward to spacing 60. Initial `sqrtPriceX64` is the curve spot `(virtual_quote + real_quote) / token_reserve`. The Position NFT sits in a shared `BluefinPositionLock` for `Config.lp_lock_ms` (180 days); the creator calls `claim_bluefin_position` after `unlock_ms`.

`lock::lock_graduated_lp` remains as the raw-coin vault for tests and as a fallback.

Types (`GlobalConfig`, `Pool`, `Position`) stay on the original Bluefin package `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267`. The official interface CALLs published-at `0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c`. Unit tests never invoke `arena::bluefin`.

Graduation emits `BluefinLockEvent` (spot pool + position ids). The original `LockEvent` is unchanged so the package stays upgrade-compatible.

## Holder registry

Sui coins have no transfer hooks. Reflections and pit-holder claims follow **net bought through the pool**. Sending `Coin<T>` elsewhere does not move the registry.

## Build / test

```
sui move test -e mainnet
```

Bluefin's own Move.toml pins Sui `mainnet-v1.35.2` (`override=true`). Arena overrides Sui to `framework/mainnet` so CLI 1.78's test VM can run; the interface still CALLs the live Bluefin package. The Bluefin README git tag `mainnet-v1.35.2` is not on their repo; the dep uses `main`.
