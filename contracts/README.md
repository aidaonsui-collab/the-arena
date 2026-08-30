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

`Pit<SUI>` is created and registered as canonical at publish. Opening a pit now
takes the `AdminCap` and registers it against `Config` in the same call — a pit
anyone could share is a pot whose bell that person controls:

```
sui client call --package <ARENA> --module config --function create_pit \
  --type-args 0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM \
  --args <CONFIG> <ADMIN_CAP>
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

Creator already published `Coin<T>` and brings both sides of LP (`Coin<T>` + `Coin<Q>` where Q is SUI or XAUM). One call seeds a Bluefin Spot pool at those amounts, shares it, and vaults the Position NFT in `BluefinPositionLock` forever (`unlock_ms = 0`; `claim_bluefin_position` aborts). Liquidity never comes out. Anyone can poke `launch::collect_instadex_fees`. Bluefin keeps 20% of the 1% swap fee; the remaining LP share of the quote (coin B) splits Config.std_* bps (default 60/10/30 creator/platform/pit). Token (coin A) fees are burned through the vaulted `InstadexMintLock<T>` TreasuryCap (zero A is `destroy_zero`, not burn). `TreasuryCap<T>` stays locked (no extract, no mint).

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

Anyone can poke `launch::collect_instadex_fees<A, B>` — Bluefin LP fees accrue on the vaulted NFT. Quote (coin B) splits 60/10/30 creator/platform/pit via `config::take_platform` and the pit (remainder dust to creator). Token (coin A) is burned via `InstadexMintLock.cap`. Emits `CollectLpFeesEvent` (quote split) plus `InstadexBurnEvent` (A amount). `collect_lp_fees` aborts `use_instadex_collect` (24). `collect_bluefin_fees` aborts `use_split_collect` (23). `claim_bluefin_position` aborts (`still_locked`) while `unlock_ms == 0`.

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

Do not pass `Pit<T>` — pit and platform bags are quote-typed. Do not call `config.fee_split` on collected amounts (that takes another `swap_fee_bps`). Call latest published-at `0x47ea732e44f21470aa3dd449a7b26731ed2c377e2c02e650f3ede6ea581bf000`, not the type-origin package.

## Graduation

Trading freezes when the real `quote_reserve` hits the quote threshold. (It used
to be `raised`, which never fell on sells and so could be wash-traded over the
line; `raised` is still the gross tape counter.) Production then seeds a Bluefin Spot pool and time-locks the Position NFT:

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

`lock::lock_graduated_lp_admin` remains as the raw-coin vault fallback, now
AdminCap-gated. The old permissionless `lock_graduated_lp` raced the Bluefin
seed for the same one-shot `lp_locked` flag and is retired (abort 25).

Types (`GlobalConfig`, `Pool`, `Position`) stay on the original Bluefin package `0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267`. The official interface CALLs published-at `0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c`. Unit tests never invoke `arena::bluefin`.

Graduation emits `BluefinLockEvent` (spot pool + position ids). The original `LockEvent` is unchanged so the package stays upgrade-compatible.

## Holder registry

Sui coins have no transfer hooks. Reflections and pit-holder claims follow **net
bought through the pool**. Sending `Coin<T>` elsewhere does not move the registry
— so selling into the curve now requires registry weight to back it, and tokens
acquired by transfer must be sold from the wallet that bought them (abort 27).
Without that check, buy → transfer → sell-from-a-fresh-wallet left the buyer's
dividend weight in place forever and could be looped.

## Security fixes (v7)

An audit of v6 found the pit unauthorized: four of its `public` functions took
the pot, the leader, or the round length from whatever the caller passed. The
worst let anyone read the winning pool id off `BellEvent`, call
`pit::settle_to_holders`, and pipe the pot to themselves in one PTB.

The `UpgradeCap` is on the `Compatible` policy, which forbids removing a public
function or narrowing its visibility, so each hole is closed the same way
`lock::collect_lp_fees` already was: the public signature stays, its body aborts
with `errors::retired()` (25), and the real logic moved to a `public(package)`
twin. **Retired entrypoints — anything still calling these breaks:**

| Retired | Replacement |
| --- | --- |
| `pit::create_pit` | `config::create_pit` (AdminCap, registers as canonical) |
| `pit::ring` | `config::ring_pit` — round length from `Config`, not the caller |
| `pit::nudge` | internal; reached through `pool::buy` / `sell` |
| `pit::take_fee` | internal |
| `pit::settle_to_holders` / `settle_burn_quote` | `pool::settle_pit` |
| `pool::burn_from_pit` | internal; reached through `pool::settle_pit` |
| `lock::lock_graduated_lp` | `lock::lock_graduated_lp_admin` (AdminCap) |

Behaviour changes beyond authorization:

- **Graduation is measured on `quote_reserve`, not `raised`.** `raised` only ever
  went up, so a buy → sell cycle added its full notional every time and could
  carry a pool over the threshold for a couple of percent in fees. `raised`
  stays as the gross tape counter; graduation now tracks the money that is
  really in the curve.
- **Selling requires registry weight.** Sui coins have no transfer hook, so
  buying, moving the coin to a fresh wallet, and selling from there used to
  leave the buyer's dividend weight in place forever — a loop that bought
  permanent reflection share for ~2% of notional per cycle. Tokens acquired by
  transfer must now be sold from the wallet that bought them (abort 27).
- **Reflection is distributed before the buyer is credited**, matching `sell`.
  A large buyer no longer gets most of their own reflection fee handed back.
- **A reflection fee with nobody to pay goes to the creator**, not into a pot
  with no claim behind it. Settling the pit to a pool with zero registered
  supply aborts (28) and leaves the pot in the pit for the next round, instead
  of stranding it unclaimable.
- `Config` setters reject values that brick launches, `swap_fee_bps` is capped at
  1000, and `round_ms` at 30 days.

### Upgrade runbook

The canonical-pit check fails open while a quote type has no registered pit, so
trading keeps working in the window between the upgrade landing and the pits
being registered. Close that window immediately:

1. Publish the upgrade with the `UpgradeCap`.
2. `config::register_pit<SUI>(Config, AdminCap, 0x8ec38e9b…)`
3. `config::register_pit<XAUM>(Config, AdminCap, 0xa8a391bf…)`
4. Verify with `config::canonical_pit<SUI>` / `<XAUM>`.
5. Point the ring keeper at `config::ring_pit` (already updated in
   `keepers/src/jobs/ringPit.ts`).

## Build / test

```
sui move test -e mainnet
```

Bluefin's own Move.toml pins Sui `mainnet-v1.35.2` (`override=true`). Arena overrides Sui to `framework/mainnet` so CLI 1.78's test VM can run; the interface still CALLs the live Bluefin package. The Bluefin README git tag `mainnet-v1.35.2` is not on their repo; the dep uses `main`.
