# Plan: basket tokens and creator basket factory

Status: design only. This document is the build plan for an on-chain **basket share token** (fixed-recipe vault) and a **creator factory** on The Arena. It is not the existing Instant **basket-yield** rewards product (`arena::basket_yield` / `BasketYieldVault`), which stages LP fee quote and converts into claimable RWA pots for meme holders.

Scope of this PR: documentation only. No Move, pad, or keeper code changes.

Mainnet references (from `contracts/PUBLISHED.md` / `contracts/Published.toml`):

- Type origin / original package: `0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`
- Latest published-at (v23): `0x1c808e5fe7f14703a72cae3cd71ebba98b3a9a97dc530feed6222595bfb4a853`
- Config: `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`
- UpgradeCap: `0x8db3965ac77247107c811cb79bccd9bf1daf5647136a0b2f8891351a56d73608` (Compatible policy)

Stocks (NVDA/AMC wraps, RH bridge) are **out of scope**. The bridge UI was sunset in PR #53; Bluefin NVDA/AMC–USDC pools are empty / not for basket components.

---

## 1. Goal

Ship a first-class **basket token**: a shared Move vault that holds component balances and mints/redeems a normal `Coin<BASKET>` share at a fixed units-per-share recipe. Creators (and later the platform) can compose baskets from the same paired assets already offered in Create, then optionally Instant-launch a meme quoted against that basket via existing hop + zap-mint paths.

Price parity is maintained by mint/redeem arbitrage, not an oracle and not rebalancing.

Contrast with the sunset RH stock bridge: no off-chain minting key, no cross-chain messages, no keeper required for mint/redeem. Keepers remain optional for adjacent Arena flows (Instadex settle, VICE buyback, existing basket-yield convert).

---

## 2. Repo map (cite real paths)

### Move (`contracts/sources/`)

| Module | Role for this plan |
| --- | --- |
| `launch.move` | Launches are generic over quote `Q`: `launch<T,Q>`, `launch_instadex<T,Q>`, `launch_instant*` / `*_v2*` / basket-yield and holder-yield variants. `InstadexMintLock<T>` holds `TreasuryCap<T>` with no extract/mint after lock. |
| `config.move` | `Config` + `AdminCap`. Per-quote Instadex open price via `InstadexQuoteParamsKey<Q>` / `InstadexQuoteParams` and `set_quote_params<Q>` / `quote_params<Q>` (v23). Instant virtual quote via `InstantVirtualQuoteKey<Q>` / `set_instant_virtual_quote<Q>`. Absent an explicit DF, non-SUI quotes fall back to XAUM-shaped params (doc comment on `quote_params`). |
| `basket_yield.move` | **Different product**: `BasketYieldVault<T,Q>`, `BasketConfig` / `BasketAsset` weight bps, `take_quote_for_convert` / `deposit_converted_asset`, push mode (`PushDistributeKey` / `push_payout`). Do not reuse as the share vault; naming collision is intentional to call out in UI/docs. |
| `pool.move` / `lock.move` / `bluefin.move` | Instant Bluefin seed + permanent LP lock. Basket share as quote `Q` must work with existing Instant path once quote params exist. |
| `events.move` | Emit parallel events for the new module; do not reshape existing Instadex / yield events. |

Design notes already in-repo (rewards baskets, not share tokens): `contracts/BASKET_YIELD.md`, `contracts/PAD_NOTE_BASKET.md`, `contracts/HOLDER_YIELD.md`.

### Pad (`index.html`)

- Paired-asset chooser: `CREATE_QUOTES` and `QUOTE_CATS` tabs **All / Sui / RWA / Memes**; pills SUI, VICEFUN, WAL, DEEP, NS, SCA, BLUE, Gold (XAUM), Silver (XAGM), T-bills (USDY), AXOL, LOFI, MANIFEST (`QUOTE_CATS` ~L1325–1330; display labels for XAUM/XAGM/USDY via `quoteLabel`).
- Pool constants: `ARENA_USDC_SUI_POOL`, `ARENA_USDY_USDC_POOL`, `ARENA_XAUM_USDC_POOL`, `ARENA_XAGM_USDC_POOL`, `ARENA_VICEFUN_SUI_POOL`, meme/native SUI pools, etc. (~L1102–1144).
- Hop builder: `hopSuiToQuoteOnTx` — SUI→USDC (7k) then Cetus USDY or Bluefin XAUM; VICEFUN Bluefin SUI pool; memes/native via 7k with fallbacks (AXOL Cetus, MANIFEST Bluefin; LOFI has **no** dedicated fallback — relies on 7k); `NATIVE_SUI_POOLS` for WAL/DEEP/NS/SCA/BLUE (`isSuiHopQuote`, `cetusHop`, `bluefinHop`, `sevenkOnto`).
- Coin-per-launch: `contracts/coin-template` bytecode embedded as `COIN_TEMPLATE_B64`; `buildCoinModule` + `@mysten/move-bytecode-template` patch identifiers/constants; Create is **two signatures** (publish coin → Instant seed). Same mechanism should publish each basket’s `Coin<BASKET>` type.

### Keepers (`keepers/src/`)

- Shared chain helpers / pool IDs: `keepers/src/chain.ts` (`CALL_PKG`, `USDC_SUI_POOL`, `XAUM_USDC_POOL`, GraphQL `gql`, …).
- Jobs (not methods on `chain.ts`): `jobs/convertBasketYield.ts` (`runConvertBasketYield` — SUI→USDC→XAUM|XAGM|USDY into existing **yield** vaults), `jobs/settleInstadex.ts` (`runSettleInstadex`), `jobs/pushViceBuyback.ts` (`runPushViceBuyback` — hops to RWA basket and pushes to VICEFUN holders). Phase 5 may change buyback to push **basket shares** instead of three tokens.

---

## 3. Product design (agreed)

### 3.1 Vault model

- Shared object vault holding component `Balance<T>` as **dynamic fields keyed by `TypeName`**.
- Fixed **recipe**: vector of `(TypeName, units_per_share)` chosen at creation and never changed.
- Share token: normal `Coin<BASKET>` with `TreasuryCap<BASKET>` locked inside the vault (same permanence idea as `InstadexMintLock`, but mint/redeem are the vault’s only uses of the cap).
- Creator picks **dollar weights** at creation; pad converts to fixed base units using current pool mid prices (same price helpers / hop snaps the pad already uses). No oracle module. No rebalancing.

### 3.2 Mint / redeem

Hot-potato receipt pattern:

1. `start_mint(vault, shares)` → `MintReceipt` (must be consumed in the same PTB).
2. `deposit<T>(vault, receipt, Coin<T>)` per component (exact proportion; abort on wrong type / over/under).
3. `finish_mint(vault, receipt)` → `Coin<BASKET>` (aborts unless every recipe leg deposited).

Redeem: burn shares → return pro-rata of every component (round **in the vault’s favor** on every division).

Parity: if secondary market price ≠ NAV, arb via mint or redeem. No dedicated Bluefin/Cetus basket pool is required for correctness; Instant Create can zap-mint into the basket quote.

### 3.3 Zap in / out (pad)

One PTB using existing hop routes:

- Zap-in: SUI (or held components) → swap to each recipe leg with slippage limits → `start_mint` / `deposit*` / `finish_mint`.
- Zap-out: burn shares → swap each component toward SUI (or target) with slippage on every hop.
- Instant Create against a basket quote: hop/zap-mint enough `Coin<BASKET>` for seed / first buy, then call existing `launch_instant_v2*` (or basket-yield variant) with `Q = BASKET`.

Reuse `hopSuiToQuoteOnTx` / `cetusHop` / `bluefinHop` / `sevenkOnto` patterns; extend a small `hopSuiToComponentsOnTx` helper rather than inventing a new DEX stack.

### 3.4 Security

Hard rules for the vault module:

- **No** admin withdraw, pause, recipe-change, or rescue that can steal balances.
- Round in vault’s favor; leftover dust stays in the vault.
- **Mandatory creator seed deposit** that is never withdrawable (first-depositor / empty-vault inflation protection). Seed size is part of creation; shares minted to creator for seed are normal shares, but a `seed_shares` / dead-share floor remains outstanding.
- **Per-basket deposit cap** (in share supply or notionals) set at creation / raiseable only via immutable policy decision after audit (prefer: cap stored at creation; raising requires a new Compatible entry gated by Arena `AdminCap` that only bumps cap, never moves funds — or force new basket). Prefer conservative: cap immutable after create until a dedicated audited upgrade.
- Isolated vault per basket (no shared custody across baskets).
- Tests: unit + proptest  - exact mint/redeem round-trips
  - receipt unfinished / wrong type / bad proportion abort
  - fuzz / randomized recipes and amounts
  - seed floor cannot be drained
  - deposit cap enforcement

- After a live soak: move basket package `UpgradeCap` behind multisig, then **destroy** (immutable). External audit before raising caps.
- Issuer freeze/blacklist risk on XAUM / XAGM / USDY is out of Arena control; it can strand value but must not enable theft of other users’ components.

### 3.5 Creator factory

Allowed components = exactly Create chooser tokens:

`SUI, VICEFUN, WAL, DEEP, NS, SCA, BLUE, XAUM, XAGM, USDY, AXOL, LOFI, MANIFEST`

(Exclude stock wraps NVDA/AMC/GME/TSLA.)

- Enforce allowlist on the **pad first**.
- Optional later: on-chain allowlist DF on Arena `Config`, gated by existing `AdminCap` — **only** gates `create_basket`, never touches vault funds.
- UI: 2–5 components, dollar-weight sliders (normalize to bps → units via live prices), name + ticker, seed deposit, optional “launch meme now” against the new basket.
- Each basket needs its own coin type: reuse Create’s publish path (`contracts/coin-template`, `COIN_TEMPLATE_B64`, `buildCoinModule`, `tickerToIdent`) so Sign 1 publishes `Coin<BASKET>` and Sign 2 seeds the vault + optional Instant launch.

### 3.6 Arena / pad changes

1. **Default quote params for factory baskets** so creators do not need a manual `AdminCap` `set_quote_params<BASKET>` per basket.

   Compatible upgrade proposal (sketch):

   - Add `config::DefaultBasketQuoteParams` (or reuse shape of `InstadexQuoteParams`) stored once on `Config`.
   - Change `quote_params<Q>` resolution order to: explicit `InstadexQuoteParamsKey<Q>` → else if `Q` is registered as a factory basket (see below) use default basket params → else SUI / XAUM fallbacks as today.
   - Registration: on basket create, write a lightweight DF on `Config` keyed by `TypeName` of `BASKET` (or emit an event the pad indexes and call `config::register_basket_quote<BASKET>(&AdminCap | &BasketFactoryCap)` in the same PTB). Prefer a **factory capability** minted to the factory module so registration does not require interactive AdminCap for every creator create, while still only adding quote metadata (no fund access).
   - Also set `set_instant_virtual_quote<BASKET>`-equivalent default (~$4.5k Instant start FDV in basket units) via the same default DF so Instant Create opens at a sane FDV without per-basket admin txs.

2. Pad chooser: fifth tab **Basket** listing live factory baskets (indexed from create events / Config DFs).

### 3.7 Optional fee

Small mint/redeem fee (e.g. ≤10–30 bps total) split creator / platform, kept low so arb stays tight. Accrue in vault DFs or route platform skim to existing `Config` platform bags only if that can be done without adding withdraw paths on the vault itself (prefer fee-on-mint retained as extra components / burned share skew — exact mechanism TBD in open questions).

---

## 4. Move interface sketch (new module)

Proposed package placement: new module `arena::basket` in the Arena package **or** a separate package with its own UpgradeCap (lean separate if immutability timeline differs from Arena Compatible cadence). Signatures below are targets for review, not frozen ABI.

```move
/// Fixed-recipe share vault. One shared object per basket.
public struct BasketVault<phantom BASKET> has key {
    id: UID,
    /// Locked forever; only mint/redeem paths use it.
    treasury: TreasuryCap<BASKET>,
    /// Immutable recipe: TypeName → units per 1 share (share decimals = coin decimals).
    recipe: vector<BasketLeg>,
    total_shares: u64,
    /// Shares that can never be redeemed (creator seed floor).
    seed_shares: u64,
    /// Max outstanding shares (incl. seed); enforced on mint.
    deposit_cap: u64,
    creator: address,
    // optional fee bps...
}

public struct BasketLeg has store, copy, drop {
    asset: TypeName,
    units_per_share: u64,
}

/// Hot potato — no store/drop/copy.
public struct MintReceipt<phantom BASKET> {
    vault_id: ID,
    shares: u64,
    /// Bitmask or table of remaining required deposits.
    // ...
}

public struct BasketCreatedEvent has copy, drop {
    vault_id: ID,
    basket_type: TypeName,
    creator: address,
    recipe: vector<BasketLeg>,
    seed_shares: u64,
    deposit_cap: u64,
}

public struct BasketMintEvent has copy, drop { vault_id: ID, shares: u64, minter: address }
public struct BasketRedeemEvent has copy, drop { vault_id: ID, shares: u64, redeemer: address }

// Creation (factory)
public fun create_basket<BASKET>(
    /* recipe, seed coins, TreasuryCap<BASKET>, deposit_cap, … */
    ctx: &mut TxContext,
): /* shared vault */;

// Mint
public fun start_mint<BASKET>(vault: &BasketVault<BASKET>, shares: u64): MintReceipt<BASKET>;
public fun deposit<BASKET, T>(
    vault: &mut BasketVault<BASKET>,
    receipt: &mut MintReceipt<BASKET>,
    coin: Coin<T>,
);
public fun finish_mint<BASKET>(
    vault: &mut BasketVault<BASKET>,
    receipt: MintReceipt<BASKET>,
    ctx: &mut TxContext,
): Coin<BASKET>;

// Redeem
public fun redeem<BASKET>(
    vault: &mut BasketVault<BASKET>,
    shares: Coin<BASKET>,
    ctx: &mut TxContext,
): /* multi-coin via PTB helper entries or vector of Coin via hot-potato RedeemReceipt */;
```

Redeem ergonomics option: mirror mint with `start_redeem` → `take<T>` → `finish_redeem` so a PTB can swap each leg without needing N return values from one Move call.

**Explicitly absent:** `admin_withdraw`, `set_recipe`, `pause`, `migrate_balances`.

---

## 5. Pre-launch component checks

Queried 2026-09-24 via Sui GraphQL (`https://graphql.mainnet.sui.io/graphql`). Public fullnode JSON-RPC is deprecated (method not found); do not rely on it.

### 5.1 Mint authority / supply

| Token | Type | CoinMetadata supply (base) | TreasuryCap object | Owner finding |
| --- | --- | --- | --- | --- |
| AXOL | `0xf00e…::axol::AXOL` | `1000000000000000000` (1B @ 9dp) | `0x3fefc6005e9553e9abf888f85b6f7e0c47c5eed9cafa6741918402ccf7eb3aaa` | Cap is a DOF under shared `0x7ead…::ipx_coin_standard::IPXTreasuryStandard` (`0x9c10…`), `can_burn: true`, `maximum_supply: null`. **Not** Immutable — mint path may still exist via IPX standard. **TODO:** audit IPXTreasuryStandard admin/mint gates before large AXOL weight. |
| LOFI | `0xf22d…::LOFI::LOFI` | `1000000000000000000` | `0x5646fe8b8290d90179e560531b549c0d337258adfa9b3d04b51fe7bada0f7190` | Owner **`Immutable`** — mint authority burned. Supply fixed at metadata value. |
| MANIFEST | `0xc466…::manifest::MANIFEST` | `999999963491866865` | `0x965885825864f5978661b7555f4974cb2e51f06ad4a1087751280aeaf9b51292` | Cap under shared `0xa204…::ipx_coin_standard::IPXTreasuryStandard` (`0xbdf7…`), `can_burn: true`, `maximum_supply: 1000000000000000000`. Circulating slightly below max. **TODO:** same IPX auth audit as AXOL. |

### 5.2 Pool depth (raw balances from pool objects; human ≈ base / 10^decimals)

| Pool const (pad) | Venue / type prefix | coin_a | coin_b | Notes |
| --- | --- | --- | --- | --- |
| `ARENA_AXOL_SUI_POOL` | Cetus `0x1eab…::pool` | ~2.014e16 AXOL (~20.14M) | ~4.731e12 SUI (~4.73k) | Pad fallback: `cetusHop` |
| `ARENA_LOFI_SUI_POOL` | Turbos `0x91bf…::pool` | ~1.265e16 LOFI (~12.65M) | ~3.662e13 SUI (~36.62k) | Pad has **no** LOFI-specific hop fallback; zap depends on 7k. **TODO:** add Turbos hop or pin a Cetus/Bluefin LOFI pool before LOFI-heavy baskets. |
| `ARENA_MANIFEST_SUI_POOL` | Bluefin `0x3492…::pool` | ~5.458e16 MANIFEST (~54.58M) | ~1.867e13 SUI (~18.67k) | Pad fallback: `bluefinHop` |
| `ARENA_XAUM_USDC_POOL` | Bluefin | ~9.500e10 XAUM (~95.0) | ~4.302e10 USDC (~43,022 @ 6dp) | Thin USD side vs memes — size RWA basket cap by this leg |
| `ARENA_XAGM_USDC_POOL` | Bluefin | ~1.778e12 XAGM (~1,778) | ~2.254e10 USDC (~22,536) | |
| `ARENA_USDY_USDC_POOL` | Cetus | ~1.823e12 USDC | ~2.013e11 USDY (~201,347 @ 6dp) | |
| `ARENA_USDC_SUI_POOL` | Cetus | ~4.349e11 USDC | ~2.725e14 SUI (~272.5k) | Shared hop spine |
| `ARENA_WAL_SUI_POOL` | Bluefin | ~3.870e15 WAL | ~1.845e13 SUI (~18.45k) | |
| `ARENA_DEEP_SUI_POOL` | Cetus | ~2.376e13 DEEP | ~2.120e14 SUI (~211.96k) | |
| `ARENA_NS_SUI_POOL` | Cetus | ~2.189e12 NS (@6dp ≈ 2.19M) | ~1.779e13 SUI (~17.79k) | |
| `ARENA_VICEFUN_SUI_POOL` | Bluefin | ~3.679e17 VICEFUN | ~1.151e13 SUI (~11.51k) | |

**Cap guidance:** for a Gold/Silver/T-bills basket, initial `deposit_cap` should be sized from the **thinnest** hop leg (today XAUM/USDC ~$43k USDC inventory is the obvious constraint — treat as order-of-magnitude only; re-measure at launch). Never fabricate USD notionals beyond what pool inventories support.

SCA/BLUE pool depth not pulled in this pass — **TODO** before phase 4 factory allowlist finalization.

---

## 6. Rollout phases

### Phase 1 — Core vault + tests (testnet)

- New `basket` module + receipt mint/redeem; stand-in coins.
- Seed floor, deposit cap, round-in-favor, fuzz tests.
- No pad factory yet; scripts for create/mint/redeem.

**Acceptance:** Move tests green; unfinished receipt aborts; seed cannot be fully redeemed; cap enforced; testnet dry-run PTBs succeed.

### Phase 2 — Mainnet RWA basket (platform-created)

- Create one Gold/Silver/T-bills basket (XAUM/XAGM/USDY) with **small** deposit cap.
- Live mint/redeem + zap via existing Cetus/Bluefin hops (`ARENA_USDC_SUI_POOL` → USDY/XAUM/XAGM pools).
- Monitor inventory vs hop slippage for a soak period.

**Acceptance:** Successful mainnet mint and redeem for ≥2 wallets; zap PTB with slippage limits; no admin path exercised; cap binds when hit.

### Phase 3 — DEEP / WAL / NS basket

- Second platform basket using `NATIVE_SUI_POOLS` / pad hop paths.
- Re-check pool depth at create time; set cap from thinnest SUI leg.

**Acceptance:** Same as phase 2 for this recipe; pad can zap with WAL Bluefin + DEEP/NS Cetus hops.

### Phase 4 — Creator factory + Basket tab + quote defaults

- Compatible Arena upgrade: default basket quote params + registration hook (see §3.6).
- Pad: Basket tab; factory UI (2–5 legs, weights, seed, optional Instant launch).
- Pad allowlist = `CREATE_QUOTES`; publish basket coin via existing template path.

**Acceptance:** Creator creates basket without AdminCap `set_quote_params`; Instant Create lists basket under Basket tab and completes launch_instant_v2 against `Q=BASKET`; explicit non-allowlisted type rejected in UI.

### Phase 5 — Optional follow-ons

- `$VICEFUN` `pushViceBuyback` pushes **basket shares** instead of three RWA transfers (gas savings); still uses hop+mint or pre-minted inventory.
- On-chain component allowlist on `Config` (create-gate only).
- Raise caps after external audit; UpgradeCap multisig → destroy.

**Acceptance:** Buyback job dry-run then live flag path distributes `Coin<BASKET>`; allowlist rejects non-listed create on-chain; audit report filed before cap raise.

---

## 7. Open questions

1. Same Arena package vs separate immutable package for `basket`?
2. Redeem API: multi-`take` receipt vs single call + pad splits?
3. Fee mechanism that cannot become a stealth withdraw (share burn vs component skim)?
4. How to register factory basket types for `quote_params` without per-create AdminCap (FactoryCap vs event+keeper)?
5. LOFI zap: add Turbos hop support or require a Cetus/Bluefin pool constant?
6. IPXTreasuryStandard mint authority for AXOL/MANIFEST — who holds the IPX admin, and is mint practically disabled?
7. Share decimals / units_per_share scaling when mixing 6dp (USDY, NS, USDC hops) and 9dp assets?
8. Should basket vault UpgradeCap destruction be package-wide or module-policy only?
9. Indexing: new API table for baskets vs reuse trades/rewards indexers?

---

## 8. Naming collision note

- **Basket token (this plan):** tradable `Coin<BASKET>` backed 1:1 by fixed recipe balances.
- **Basket yield (live):** `arena::basket_yield::BasketYieldVault` — meme holder rewards funded from Instant LP fee slice (`collect_instadex_fees_basket_yield`, convert keeper).

UI and docs must never use “basket” alone without qualifier.

---

## 9. Out of scope

- Stock wraps / RH bridge (PR #53 sunset).
- Oracle-based rebalancing or NAV feeds.
- Cross-basket flash loans / shared liquidity.
- Changing existing `basket_yield` economics except optional phase-5 buyback asset shape.
