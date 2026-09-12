/// Instadex Instant RWA basket yield (v2).
///
/// BidX-style multi-asset holder rewards: Instant pair is quoted in `Q`
/// (typically SUI), while selected RWAs (XAUM / XAGM / USDY) are what holders
/// claim. Fee pit-bps slice stages as `Balance<Q>`; keepers take staging Q and
/// deposit allowlisted RWA into per-asset pots (off-module SUI→RWA swap).
/// See `contracts/BASKET_YIELD.md`.
///
/// Compatible-safe new module — does not alter v1 `holder_yield` Instant path.
module arena::basket_yield;

use arena::errors;
use arena::events;
use std::type_name::{Self, TypeName};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use sui::object::{Self, ID, UID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::TxContext;
use sui::vec_set::{Self, VecSet};

/// Magnified-dividend scalar (1e12). Same as `holder_yield` / `pool::MAG`.
const MAG: u256 = 1_000_000_000_000;
const BPS: u64 = 10_000;
const MAX_ASSETS: u64 = 3;

/// Claim every selected RWA stream in one pull (pad: one `claim_all`/`claim_asset` per leg).
const PAYOUT_ALL_AT_ONCE: u8 = 0;
/// Claim the cursor asset only; `claim_rotating` pays then advances.
const PAYOUT_ROTATING: u8 = 1;

/// One allowlisted RWA leg + optional weight (ignored when `equal_weight`).
public struct BasketAsset has store, copy, drop {
    asset: TypeName,
    weight_bps: u64,
}

/// Launch-locked basket parameters (snapshot for vault + events).
public struct BasketConfig has store, copy, drop {
    assets: vector<BasketAsset>,
    equal_weight: bool,
    payout_mode: u8,
}

/// Per-address registration weight. Quote staging share is pro-rata of
/// `quote_staging` (no claim of Q — convert pays staging to the keeper).
/// RWA claim debt lives in `asset_acc` keyed by `(who, asset)`.
public struct BasketHolder has store, drop {
    amount: u64,
}

/// DF key for a typed RWA pot on the vault UID.
public struct AssetPotKey has copy, drop, store {
    asset: TypeName,
}

/// Per-RWA custody. Magnified index is in `BasketYieldVault.asset_mps`.
public struct AssetPot<phantom A> has store {
    bal: Balance<A>,
}

/// Composite key for per-holder per-asset magnified debt.
public struct HolderAssetKey has copy, drop, store {
    who: address,
    asset: TypeName,
}

public struct AssetAcc has store, drop {
    debt: u256,
    unpaid: u64,
}

/// Shared basket vault bound 1:1 to an Instadex `BluefinPositionLock`.
/// RWA pots are DFs on `id` keyed by `AssetPotKey`.
public struct BasketYieldVault<phantom T, phantom Q> has key {
    id: UID,
    lock_id: ID,
    bluefin_pool_id: ID,
    config: BasketConfig,
    holders: Table<address, BasketHolder>,
    total_registered: u64,
    /// Pit-bps quote slice before convert into RWA pots.
    quote_staging: Balance<Q>,
    /// Unused quote mps slot (staging uses balance pro-rata; kept for layout stability).
    mps: u256,
    /// Active index into `config.assets` for `PAYOUT_ROTATING`.
    rotate_index: u64,
    /// Per-asset magnified per-share (TypeName → mps).
    asset_mps: Table<TypeName, u256>,
    /// Per-holder per-asset debt / unpaid.
    asset_acc: Table<HolderAssetKey, AssetAcc>,
}

// === Config constructors / views ===

public fun payout_all_at_once(): u8 { PAYOUT_ALL_AT_ONCE }
public fun payout_rotating(): u8 { PAYOUT_ROTATING }
public fun max_assets(): u64 { MAX_ASSETS }
public fun bps(): u64 { BPS }

/// Build a config; aborts on bad weights / empty / mode / duplicates.
public fun new_config(
    assets: vector<BasketAsset>,
    equal_weight: bool,
    payout_mode: u8,
): BasketConfig {
    let cfg = BasketConfig { assets, equal_weight, payout_mode };
    validate_config(&cfg);
    cfg
}

public fun new_asset(asset: TypeName, weight_bps: u64): BasketAsset {
    BasketAsset { asset, weight_bps }
}

public fun validate_config(cfg: &BasketConfig) {
    let n = cfg.assets.length();
    assert!(n > 0, errors::basket_empty());
    assert!(n <= MAX_ASSETS, errors::basket_bad_weights());
    assert!(
        cfg.payout_mode == PAYOUT_ALL_AT_ONCE || cfg.payout_mode == PAYOUT_ROTATING,
        errors::basket_mode(),
    );
    let mut seen = vec_set::empty<TypeName>();
    let mut i = 0;
    let mut sum = 0u64;
    while (i < n) {
        let a = &cfg.assets[i];
        assert!(!seen.contains(&a.asset), errors::basket_bad_weights());
        seen.insert(a.asset);
        if (!cfg.equal_weight) {
            assert!(a.weight_bps > 0, errors::basket_bad_weights());
            sum = sum + a.weight_bps;
        };
        i = i + 1;
    };
    if (!cfg.equal_weight) {
        assert!(sum == BPS, errors::basket_bad_weights());
    };
}

public fun config_asset_count(cfg: &BasketConfig): u64 { cfg.assets.length() }
public fun config_equal_weight(cfg: &BasketConfig): bool { cfg.equal_weight }
public fun config_payout_mode(cfg: &BasketConfig): u8 { cfg.payout_mode }
public fun config_assets(cfg: &BasketConfig): &vector<BasketAsset> { &cfg.assets }
public fun asset_type(a: &BasketAsset): TypeName { a.asset }
public fun asset_weight_bps(a: &BasketAsset): u64 { a.weight_bps }

public fun config_contains_asset(cfg: &BasketConfig, asset: TypeName): bool {
    let n = cfg.assets.length();
    let mut i = 0;
    while (i < n) {
        if (cfg.assets[i].asset == asset) {
            return true
        };
        i = i + 1;
    };
    false
}

public fun assert_asset_in_config(cfg: &BasketConfig, asset: TypeName) {
    assert!(config_contains_asset(cfg, asset), errors::unknown_rwa());
}

/// Equal-weight bps for index `i` (floor split; remainder on last leg).
public fun equal_weight_bps(cfg: &BasketConfig, i: u64): u64 {
    let n = cfg.assets.length();
    assert!(n > 0, errors::basket_empty());
    assert!(i < n, errors::bad_param());
    let base = BPS / n;
    if (i + 1 == n) {
        BPS - base * (n - 1)
    } else {
        base
    }
}

/// Effective weight for asset index (equal or explicit).
public fun effective_weight_bps(cfg: &BasketConfig, i: u64): u64 {
    if (cfg.equal_weight) {
        equal_weight_bps(cfg, i)
    } else {
        cfg.assets[i].weight_bps
    }
}

/// Weight-proportional quote slice for one convert round of `quote_amount`.
public fun quote_share_for_index(cfg: &BasketConfig, i: u64, quote_amount: u64): u64 {
    let w = effective_weight_bps(cfg, i);
    (quote_amount as u128 * (w as u128) / (BPS as u128)) as u64
}

// === Vault lifecycle ===

/// Create and share a vault. Called once at Instant basket launch.
public(package) fun create_and_share<T, Q>(
    lock_id: ID,
    bluefin_pool_id: ID,
    config: BasketConfig,
    ctx: &mut TxContext,
): ID {
    validate_config(&config);
    let vault = BasketYieldVault<T, Q> {
        id: object::new(ctx),
        lock_id,
        bluefin_pool_id,
        config,
        holders: table::new(ctx),
        total_registered: 0,
        quote_staging: balance::zero<Q>(),
        mps: 0,
        rotate_index: 0,
        asset_mps: table::new(ctx),
        asset_acc: table::new(ctx),
    };
    let id = object::id(&vault);
    transfer::share_object(vault);
    id
}

/// Alias for migrate / launch: vault bound to an existing Instant lock
/// (no Bluefin reseed). Same as `create_and_share`.
public(package) fun create_vault_for_lock<T, Q>(
    lock_id: ID,
    bluefin_pool_id: ID,
    config: BasketConfig,
    ctx: &mut TxContext,
): ID {
    create_and_share<T, Q>(lock_id, bluefin_pool_id, config, ctx)
}

/// Stage the pit-bps quote slice. On no holders / zero, returns `fee` for
/// creator residual rescue (same pattern as `holder_yield::try_fund`).
/// Does **not** credit claimable Q — convert pays staging to the keeper; holders
/// claim RWA after `deposit_converted_asset`.
public(package) fun try_fund_quote<T, Q>(
    vault: &mut BasketYieldVault<T, Q>,
    fee: Balance<Q>,
    clock: &Clock,
): Balance<Q> {
    let amount = fee.value();
    if (amount == 0 || vault.total_registered == 0) {
        return fee
    };
    vault.quote_staging.join(fee);
    events::emit_basket_yield_funded(
        vault.lock_id,
        object::id(vault),
        vault.bluefin_pool_id,
        type_name::with_defining_ids<Q>(),
        amount,
        clock.timestamp_ms(),
    );
    balance::zero<Q>()
}

/// Set registry weight to `coin.value()`. Accrues unpaid RWA before the update.
public fun sync_registration<T, Q>(
    vault: &mut BasketYieldVault<T, Q>,
    coin: &Coin<T>,
    ctx: &TxContext,
) {
    let who = ctx.sender();
    let new_amt = coin.value();
    ensure_holder(vault, who);
    accrue_all_assets(vault, who);
    let h = vault.holders.borrow_mut(who);
    let old = h.amount;
    if (new_amt >= old) {
        vault.total_registered = vault.total_registered + (new_amt - old);
    } else {
        vault.total_registered = vault.total_registered - (old - new_amt);
    };
    h.amount = new_amt;
    reset_asset_debts(vault, who, new_amt);
}

// === Convert MVP (no in-Move DEX) ===

/// Permissionless: take `amount` of staged quote as payment for an off-module
/// Q→RWA hop. Pair with `deposit_converted_asset` in the same PTB (after swap).
public fun take_quote_for_convert<T, Q>(
    vault: &mut BasketYieldVault<T, Q>,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Q> {
    assert!(amount > 0, errors::zero_amount());
    assert!(amount <= vault.quote_staging.value(), errors::bad_param());
    coin::from_balance(vault.quote_staging.split(amount), ctx)
}

/// Deposit one allowlisted RWA into its pot and credit magnified dividends.
/// `quote_spent` is attributed in the convert event (weight-proportional share of
/// the staging Q taken this round — keeper/UI computes via `quote_share_for_index`).
public fun deposit_converted_asset<T, Q, A>(
    vault: &mut BasketYieldVault<T, Q>,
    coin_a: Coin<A>,
    quote_spent: u64,
    clock: &Clock,
) {
    let tn = type_name::with_defining_ids<A>();
    assert_asset_in_config(&vault.config, tn);
    let to_amount = coin_a.value();
    assert!(to_amount > 0, errors::zero_amount());
    assert!(vault.total_registered > 0, errors::no_holders());

    ensure_asset_pot<T, Q, A>(vault, tn);
    {
        let pot: &mut AssetPot<A> = df::borrow_mut(&mut vault.id, AssetPotKey { asset: tn });
        pot.bal.join(coin_a.into_balance());
    };

    if (!vault.asset_mps.contains(tn)) {
        vault.asset_mps.add(tn, 0);
    };
    let total = vault.total_registered;
    {
        let amps = vault.asset_mps.borrow_mut(tn);
        *amps = *amps + (to_amount as u256) * MAG / (total as u256);
    };

    let lock_id = vault.lock_id;
    let vault_id = object::id(vault);
    events::emit_basket_yield_converted(
        lock_id,
        vault_id,
        type_name::with_defining_ids<Q>(),
        quote_spent,
        tn,
        to_amount,
        clock.timestamp_ms(),
    );
}

/// Retired stub kept for Compatible public linkage. Use `take_quote_for_convert`
/// + `deposit_converted_asset`.
public fun convert_stub<T, Q>(_vault: &mut BasketYieldVault<T, Q>) {
    abort errors::retired()
}

// === Claims ===

/// All-at-once mode: claim pending for asset `A` (pad calls once per basket leg).
public fun claim_all<T, Q, A>(
    vault: &mut BasketYieldVault<T, Q>,
    ctx: &mut TxContext,
): Coin<A> {
    assert!(vault.config.payout_mode == PAYOUT_ALL_AT_ONCE, errors::basket_mode());
    claim_asset_inner(vault, ctx)
}

/// Claim pending for one asset regardless of payout mode (PTB building block).
public fun claim_asset<T, Q, A>(
    vault: &mut BasketYieldVault<T, Q>,
    ctx: &mut TxContext,
): Coin<A> {
    claim_asset_inner(vault, ctx)
}

/// Rotating mode: claim the cursor asset, then advance `rotate_index`.
public fun claim_rotating<T, Q, A>(
    vault: &mut BasketYieldVault<T, Q>,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<A> {
    assert!(vault.config.payout_mode == PAYOUT_ROTATING, errors::basket_mode());
    let tn = type_name::with_defining_ids<A>();
    let idx = vault.rotate_index;
    assert!(idx < vault.config.assets.length(), errors::bad_param());
    assert!(vault.config.assets[idx].asset == tn, errors::unknown_rwa());
    let c = claim_asset_inner<T, Q, A>(vault, ctx);
    advance_rotation(vault, clock);
    c
}

/// Advance rotating cursor (permissionless). No-op-safe for all-at-once? Aborts
/// if not rotating mode.
public fun advance_rotation<T, Q>(
    vault: &mut BasketYieldVault<T, Q>,
    clock: &Clock,
) {
    assert!(vault.config.payout_mode == PAYOUT_ROTATING, errors::basket_mode());
    let n = vault.config.assets.length();
    assert!(n > 0, errors::basket_empty());
    let from = vault.rotate_index;
    let to = (from + 1) % n;
    vault.rotate_index = to;
    events::emit_basket_yield_rotate(
        vault.lock_id,
        object::id(vault),
        from,
        to,
        vault.config.assets[to].asset,
        clock.timestamp_ms(),
    );
}

// === Views ===

public fun assert_bound_to_lock<T, Q>(vault: &BasketYieldVault<T, Q>, lock_id: ID) {
    assert!(vault.lock_id == lock_id, errors::wrong_basket());
}

public fun lock_id<T, Q>(vault: &BasketYieldVault<T, Q>): ID { vault.lock_id }
public fun bluefin_pool_id<T, Q>(vault: &BasketYieldVault<T, Q>): ID { vault.bluefin_pool_id }
public fun total_registered<T, Q>(vault: &BasketYieldVault<T, Q>): u64 { vault.total_registered }
public fun quote_staging_value<T, Q>(vault: &BasketYieldVault<T, Q>): u64 {
    vault.quote_staging.value()
}
public fun mps<T, Q>(vault: &BasketYieldVault<T, Q>): u256 { vault.mps }
public fun rotate_index<T, Q>(vault: &BasketYieldVault<T, Q>): u64 { vault.rotate_index }
public fun vault_config<T, Q>(vault: &BasketYieldVault<T, Q>): &BasketConfig { &vault.config }

public fun holder_amount<T, Q>(vault: &BasketYieldVault<T, Q>, who: address): u64 {
    if (!vault.holders.contains(who)) {
        0
    } else {
        vault.holders.borrow(who).amount
    }
}

/// Pro-rata share of remaining quote staging (not pull-claimable; convert takes it).
public fun pending_quote_normalized<T, Q>(vault: &BasketYieldVault<T, Q>, who: address): u64 {
    if (!vault.holders.contains(who) || vault.total_registered == 0) {
        return 0
    };
    let amt = vault.holders.borrow(who).amount;
    let staging = vault.quote_staging.value();
    ((staging as u128) * (amt as u128) / (vault.total_registered as u128)) as u64
}

public fun asset_mps_of<T, Q>(vault: &BasketYieldVault<T, Q>, asset: TypeName): u256 {
    if (!vault.asset_mps.contains(asset)) {
        0
    } else {
        *vault.asset_mps.borrow(asset)
    }
}

public fun pot_value<T, Q, A>(vault: &BasketYieldVault<T, Q>): u64 {
    let tn = type_name::with_defining_ids<A>();
    if (!df::exists(&vault.id, AssetPotKey { asset: tn })) {
        0
    } else {
        let pot: &AssetPot<A> = df::borrow(&vault.id, AssetPotKey { asset: tn });
        pot.bal.value()
    }
}

public fun pending_asset<T, Q, A>(vault: &BasketYieldVault<T, Q>, who: address): u64 {
    let tn = type_name::with_defining_ids<A>();
    if (!vault.holders.contains(who)) {
        return 0
    };
    let amount = vault.holders.borrow(who).amount;
    let amps = asset_mps_of(vault, tn);
    let key = HolderAssetKey { who, asset: tn };
    let (debt, unpaid) = if (vault.asset_acc.contains(key)) {
        let a = vault.asset_acc.borrow(key);
        (a.debt, a.unpaid)
    } else {
        (0u256, 0u64)
    };
    let accum = (amount as u256) * amps;
    let extra = if (accum > debt) {
        u256_to_u64((accum - debt) / MAG)
    } else {
        0
    };
    unpaid + extra
}

// === Internals ===

fun claim_asset_inner<T, Q, A>(
    vault: &mut BasketYieldVault<T, Q>,
    ctx: &mut TxContext,
): Coin<A> {
    let who = ctx.sender();
    let tn = type_name::with_defining_ids<A>();
    assert_asset_in_config(&vault.config, tn);
    assert!(vault.holders.contains(who), errors::nothing_to_claim());
    accrue_asset(vault, who, tn);
    let key = HolderAssetKey { who, asset: tn };
    assert!(vault.asset_acc.contains(key), errors::nothing_to_claim());
    let amt = {
        let acc = vault.asset_acc.borrow_mut(key);
        let a = acc.unpaid;
        acc.unpaid = 0;
        a
    };
    assert!(amt > 0, errors::nothing_to_claim());
    assert!(df::exists(&vault.id, AssetPotKey { asset: tn }), errors::nothing_to_claim());
    let lock_id = vault.lock_id;
    let vault_id = object::id(vault);
    let mode = vault.config.payout_mode;
    let out = {
        let pot: &mut AssetPot<A> = df::borrow_mut(&mut vault.id, AssetPotKey { asset: tn });
        coin::from_balance(pot.bal.split(amt), ctx)
    };
    events::emit_basket_yield_claim(
        lock_id,
        vault_id,
        who,
        tn,
        amt,
        mode,
    );
    out
}

fun ensure_asset_pot<T, Q, A>(vault: &mut BasketYieldVault<T, Q>, tn: TypeName) {
    let key = AssetPotKey { asset: tn };
    if (!df::exists(&vault.id, key)) {
        df::add(&mut vault.id, key, AssetPot<A> { bal: balance::zero<A>() });
    };
}

fun ensure_holder<T, Q>(vault: &mut BasketYieldVault<T, Q>, who: address) {
    if (!vault.holders.contains(who)) {
        vault.holders.add(who, BasketHolder { amount: 0 });
    }
}

fun ensure_asset_acc<T, Q>(vault: &mut BasketYieldVault<T, Q>, who: address, asset: TypeName) {
    let key = HolderAssetKey { who, asset };
    if (!vault.asset_acc.contains(key)) {
        vault.asset_acc.add(key, AssetAcc { debt: 0, unpaid: 0 });
    }
}

fun accrue_all_assets<T, Q>(vault: &mut BasketYieldVault<T, Q>, who: address) {
    let n = vault.config.assets.length();
    let mut i = 0;
    while (i < n) {
        let tn = vault.config.assets[i].asset;
        accrue_asset(vault, who, tn);
        i = i + 1;
    };
}

fun accrue_asset<T, Q>(vault: &mut BasketYieldVault<T, Q>, who: address, asset: TypeName) {
    if (!vault.holders.contains(who)) {
        return
    };
    let amount = vault.holders.borrow(who).amount;
    let amps = asset_mps_of(vault, asset);
    ensure_asset_acc(vault, who, asset);
    let key = HolderAssetKey { who, asset };
    let acc = vault.asset_acc.borrow_mut(key);
    let accum = (amount as u256) * amps;
    if (accum > acc.debt) {
        acc.unpaid = acc.unpaid + u256_to_u64((accum - acc.debt) / MAG);
    };
    acc.debt = accum;
}

fun reset_asset_debts<T, Q>(vault: &mut BasketYieldVault<T, Q>, who: address, new_amt: u64) {
    let n = vault.config.assets.length();
    let mut i = 0;
    while (i < n) {
        let tn = vault.config.assets[i].asset;
        let amps = asset_mps_of(vault, tn);
        ensure_asset_acc(vault, who, tn);
        let key = HolderAssetKey { who, asset: tn };
        let acc = vault.asset_acc.borrow_mut(key);
        acc.debt = (new_amt as u256) * amps;
        i = i + 1;
    };
}

fun u256_to_u64(x: u256): u64 {
    assert!(x <= 18446744073709551615u256, errors::overflow());
    x as u64
}

#[test_only]
public fun create_for_testing<T, Q>(
    lock_id: ID,
    bluefin_pool_id: ID,
    config: BasketConfig,
    ctx: &mut TxContext,
): ID {
    create_and_share<T, Q>(lock_id, bluefin_pool_id, config, ctx)
}

#[test_only]
public fun fund_quote_for_testing<T, Q>(
    vault: &mut BasketYieldVault<T, Q>,
    fee: Balance<Q>,
    clock: &Clock,
): Balance<Q> {
    try_fund_quote(vault, fee, clock)
}
