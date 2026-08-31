# Arena Move package

Fair launches on Sui. Bonding curve, no presale.

## Launch modes

1. **TOKEN/SUI** — curve quoted in SUI. Graduation at 2,000 SUI.
2. **TOKEN/XAUM** — same curve, quoted in Matrixdock gold. Bluefin Spot lists this as **XAUM**, not GOLD.
3. **Reflection** — same 1% swap fee, split 50/20/20/10 reflections/creator/pit/platform.
4. **Instadex** — skip the curve. Create uses Instant: 100% of the token, **0 real quote**, price from a platform virtual quote (default 1 SUI / 10_000_000 base units for any other Q: 10 USDY or 0.01 XAGM). Create quotes are SUI, USDY, XAGM. Leftover XAUM pairs still work. `launch_instadex` remains as the two-sided seed. AdminCap `set_instant_virtual_quote<Q>` and `register_pit<Q>` after `create_pit`.

## Gold quote is XAUM

Bluefin ticker: `XAUM` (Matrixdock Gold, 1 token = 1 troy oz LBMA gold).

```
0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM
```

9 decimals. Bluefin Spot pools: XAUM/SUI, XAUM/USDC.

The package does not vendor Matrixdock sources. `Pool<T, Q>` and `Pit<Q>` are generic; pass XAUM as `Q` at the call site.

`Pit<SUI>` is created at publish. After publish, open the gold pit once, then register **both** official pits with AdminCap so Instadex collect cannot divert the 30% cut:

```
sui client call --package <ARENA> --module pit --function create_pit \
  --type-args 0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM

sui client call --package <PUBLISHED-AT> --module config --function register_pit \
  --type-args 0x2::sui::SUI \
  --args <CONFIG> <ADMIN_CAP> <PIT_SUI>

sui client call --package <PUBLISHED-AT> --module config --function register_pit \
  --type-args 0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM \
  --args <CONFIG> <ADMIN_CAP> <PIT_XAUM>
```

Graduation for XAUM defaults to **1 XAUM** (not 2,000 units). 2,000 SUI is only ~0.3 oz.

## Fees and the pit

- Launch fee: 1 SUI, even for XAUM pairs. Accrues in `Config.treasury`.
- Platform cut (10% of the 1% swap fee) accrues in `Config.platform`. Both that bag and the launch treasury are withdrawn with `AdminCap`, which init sends to Odyssey's platform wallet `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.
- 1% (`swap_fee_bps=100`) of every fill (buy quote in, sell quote out).
  - Standard: 60% creator, 10% platform, 30% pit.
  - Reflection: 50/20/20/10 holders/creator/pit/platform.
- Instant pit: highest Instant USD market cap over 24 hours wins. Previous winner sits out 48 hours. Votes are display-only (0.1 SUI still goes in the pot).
  - Buy and burn only. `config::take_pit_pot_for_burn` (AdminCap) drains the official pit; the keeper hops SUI to the winner's quote, Bluefin-buys the token, and `launch::burn_pit_buy` burns it through `InstadexMintLock`.
  - Leftover curve `pit::ring` / `pool::settle_pit` still exist. Instant take marks the pit settled so a leftover curve winner cannot strand `ring`.

## Launch (two transactions)

1. Publish a coin module so you have `TreasuryCap<T>` + `CoinMetadata<T>`.
2. Call `launch::launch<T, Q>` with 1 SUI, pit mode (`0` holders / `1` buy-and-burn), and the reflection flag.

## Instadex (no curve)

Create is Robinpad Instant: the creator publishes `Coin<T>` and pays the 1 SUI launch fee. **No quote coin.** `launch_instant` seeds a Bluefin Spot pool with 100% of `Coin<T>` and 0 quote, initializes at `tickLower` so the mint is single-sided, and vaults the Position NFT in `BluefinPositionLock` forever (`unlock_ms = 0`; `claim_bluefin_position` aborts). Starting price is `Config.instant_virtual_quote<Q>` (default 1 SUI / 0.01 XAUM; AdminCap `set_instant_virtual_quote`). Token is Bluefin coin A, quote is coin B, so collect still burns A and splits B. `launch_instadex` remains as the two-sided seed (creator brings `Coin<T>` + `Coin<Q>`). Anyone can poke `launch::collect_instadex_fees`. The pit argument must be the official `Pit<Q>` registered on Config (`config::register_pit` with AdminCap; SUI + XAUM after this upgrade). The Bluefin pool argument must match `BluefinPositionLock.bluefin_pool_id`. Bluefin keeps 20% of the 1% swap fee; the remaining LP share of the quote (coin B) splits Config.std_* bps (default 60/10/30 creator/platform/pit). Token (coin A) fees are burned through the vaulted `InstadexMintLock<T>` TreasuryCap (zero A is `destroy_zero`, not burn). `TreasuryCap<T>` stays locked (no extract, no mint).

**PTB** — `launch::launch_instant<T, Q>` / `launch_instant_entry` (returns `lock_id`):

| Arg | Object |
| --- | --- |
| `config` | Arena `Config` `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c` |
| `clock` | `0x6` |
| `bf_config` | Bluefin `GlobalConfig` `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352` |
| `treasury_cap` | `TreasuryCap<T>` (consumed into `InstadexMintLock`) |
| `meta_t` | `CoinMetadata<T>` |
| `meta_q` | `CoinMetadata<Q>` (SUI: `0x9258181f5ceac8dbffb7030890243caed69a9599d2886d957a9cb7656af3bdb3`) |
| `token` | `Coin<T>` (Bluefin A), amount > 0. 100% goes in LP. |
| `fee_sui` | 1 SUI launch fee (`Config.take_launch_fee`) |
| `creation_fee` | `Coin<SUI>` Bluefin pool-creation fee (mainnet currently 0; leftover returned to sender) |

No quote coin. No Pit, no `pit_mode`, no reflection, no Arena `Pool`, no `GraduationEvent`. Bluefin params: tick spacing 60, `fee_rate` 10_000 (1%). Range is `[floor(idealTick, 60), max usable]`, pool init at `tickLower` so paid quote is 0. Ideal tick from `sqrtPriceX64(token_amount, instant_virtual_quote<Q>)`. `BluefinPositionLock.pool_id` is `@0x0` (no curve pool); `bluefin_pool_id` is the spot pool; beneficiary is the sender. Residuals from the seed go to the creator. `launch_instadex_entry` still exists for two-sided seeds.

Emits `InstadexLaunchEvent`:

```
lock_id, bluefin_pool_id, position_id, token, quote, creator,
token_amount, quote_amount, unlock_ms, name, symbol
```

`token` / `quote` are `TypeName` via `type_name::with_defining_ids`. `unlock_ms` is always 0. Instant sets `quote_amount` to 0. Also emits `InstadexMintLockEvent { lock_id, mint_lock_id }` (Compatible parallel event; do not add fields to `InstadexLaunchEvent`). Does not emit `LaunchEvent`, `LockEvent`, `BluefinLockEvent`, or `GraduationEvent`.

Anyone can poke `launch::collect_instadex_fees<A, B>` — Bluefin LP fees accrue on the vaulted NFT. Quote (coin B) splits 60/10/30 creator/platform/pit via `config::take_platform` and `pit::take_fee` (remainder dust to creator). Token (coin A) is burned via `InstadexMintLock.cap`. Emits `CollectLpFeesEvent` (quote split) plus `InstadexBurnEvent` (A amount). `collect_lp_fees` aborts `use_instadex_collect` (24). `collect_bluefin_fees` aborts `use_split_collect` (23). `claim_bluefin_position` aborts (`still_locked`) while `unlock_ms == 0`.

**Collect PTB** — `launch::collect_instadex_fees<T, Q>` (permissionless; NFT stays in the vault):

| Arg | Object |
| --- | --- |
| `lock` | `BluefinPositionLock` |
| `mint` | `InstadexMintLock<T>` |
| `clock` | `0x6` |
| `bf_config` | Bluefin `GlobalConfig` `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352` |
| `bf_pool` | Bluefin `Pool<T, Q>` |
| `config` | Arena `Config` `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c` |
| `pit` | `Pit<Q>` (SUI: `0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`) |

Do not pass `Pit<T>` — pit and platform bags are quote-typed. Do not call `config.fee_split` on collected amounts (that takes another `swap_fee_bps`). Call latest published-at `0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9`, not the type-origin package.

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

`lock::lock_graduated_lp` remains as the raw-coin vault for tests and as a fallback. Only the pool creator can call it (so a searcher cannot grief the Bluefin seed). Buy-and-burn pit winners that already locked (or have an empty token reserve) `forfeit` instead of aborting, so the next `ring` can run. The pot stays.

Types (`GlobalConfig`, `Pool`, `Position`) stay on the original Bluefin package `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267`. The official interface CALLs published-at `0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c`. Unit tests never invoke `arena::bluefin`.

Graduation emits `BluefinLockEvent` (spot pool + position ids). The original `LockEvent` is unchanged so the package stays upgrade-compatible.

## Holder registry

Sui coins have no transfer hooks. Reflections and pit-holder claims follow **net bought through the pool**. Sending `Coin<T>` elsewhere does not move the registry.

## Build / test

```
sui move test -e mainnet
```

Bluefin's own Move.toml pins Sui `mainnet-v1.35.2` (`override=true`). Arena overrides Sui to `framework/mainnet` so CLI 1.78's test VM can run; the interface still CALLs the live Bluefin package. The Bluefin README git tag `mainnet-v1.35.2` is not on their repo; the dep uses `main`.
