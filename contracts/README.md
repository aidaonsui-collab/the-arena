# Arena Move package

Fair launches on Sui. Bonding curve, no presale.

## Launch modes

1. **TOKEN/SUI** — curve quoted in SUI. Graduation at 2,000 SUI.
2. **TOKEN/XAUM** — same curve, quoted in Matrixdock gold. Bluefin Spot lists this as **XAUM**, not GOLD.
3. **Reflection** — same 1% swap fee, split 50/20/20/10 reflections/creator/pit/platform.
4. **Instadex** — skip the curve. Creator brings both LP sides and seeds Bluefin in one call.

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

## Instadex (no curve)

Creator already published `Coin<T>` and brings both sides of LP (`Coin<T>` + `Coin<Q>` where Q is SUI or XAUM). One call seeds a Bluefin Spot pool at those amounts, shares it, and vaults the Position NFT in `BluefinPositionLock` forever (`unlock_ms = 0`; `claim_bluefin_position` aborts). Liquidity never comes out. Anyone can poke `lock::collect_lp_fees`. Bluefin keeps 20% of the 1% swap fee; the remaining LP share of the quote (coin B) splits Config.std_* bps (default 60/10/30 creator/platform/pit). Token (coin A) fees go 100% to the creator. `TreasuryCap<T>` is locked in shared `InstadexMintLock<T>` (no extract, no mint).

**PTB** — `launch::launch_instadex<T, Q>` / `launch_instadex_entry` (returns `lock_id`):

| Arg | Object |
| --- | --- |
| `config` | Arena `Config` `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c` |
| `clock` | `0x6` |
| `bf_config` | Bluefin `GlobalConfig` `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352` |
| `treasury_cap` | `TreasuryCap<T>` (consumed into `InstadexMintLock`) |
| `meta_t` | `CoinMetadata<T>` |
| `meta_q` | `CoinMetadata<Q>` (SUI: `0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3`) |
| `token` | `Coin<T>` (Bluefin A), amount > 0 |
| `quote` | `Coin<Q>` (Bluefin B), amount > 0 |
| `fee_sui` | 1 SUI launch fee (`Config.take_launch_fee`) |
| `creation_fee` | `Coin<SUI>` Bluefin pool-creation fee (mainnet currently 0; leftover returned to sender) |

No Pit, no `pit_mode`, no reflection, no Arena `Pool`, no `GraduationEvent`. Same Bluefin params as graduation: tick spacing 60, `fee_rate` 10_000 (1%), full-range ticks, `sqrtPriceX64(token_amount, quote_amount)`. `BluefinPositionLock.pool_id` is `@0x0` (no curve pool); `bluefin_pool_id` is the spot pool; beneficiary is the sender. Residuals from the seed go to the creator.

Emits `InstadexLaunchEvent`:

```
lock_id, bluefin_pool_id, position_id, token, quote, creator,
token_amount, quote_amount, unlock_ms, name, symbol
```

`token` / `quote` are `TypeName` via `type_name::with_defining_ids`. `unlock_ms` is always 0. Does not emit `LaunchEvent`, `LockEvent`, `BluefinLockEvent`, or `GraduationEvent`.

Anyone can poke `lock::collect_lp_fees<A, B>` — Bluefin LP fees accrue on the vaulted NFT. Quote (coin B) splits 60/10/30 creator/platform/pit via `config::take_platform` and `pit::take_fee` (remainder dust to creator). Token (coin A) goes to `lock.beneficiary`. `collect_bluefin_fees` aborts `use_split_collect` (23). `claim_bluefin_position` aborts (`still_locked`) while `unlock_ms == 0`.

**Collect PTB** — `lock::collect_lp_fees<T, Q>` (permissionless; NFT stays in the vault):

| Arg | Object |
| --- | --- |
| `lock` | `BluefinPositionLock` |
| `clock` | `0x6` |
| `bf_config` | Bluefin `GlobalConfig` `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352` |
| `bf_pool` | Bluefin `Pool<T, Q>` |
| `config` | Arena `Config` `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c` |
| `pit` | `Pit<Q>` (SUI: `0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`) |

Do not pass `Pit<T>` — pit and platform bags are quote-typed. Do not call `config.fee_split` on collected amounts (that takes another `swap_fee_bps`). Call the latest published-at, not the type-origin package.

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
