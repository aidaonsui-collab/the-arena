/// Instadex Instant RWA basket yield (v2 scaffold).
///
/// BidX-style multi-asset holder rewards: Instant pair is quoted in `Q`
/// (typically SUI), while selected RWAs (XAUM / XAGM / USDY) are what holders
/// eventually claim. Fee pit-bps slice stages as `Balance<Q>` here; convert +
/// multi-asset claim are stubs (`errors::retired()`) until the next Compatible
/// wiring slice. See `contracts/BASKET_YIELD.md`.
///
/// Compatible-safe new module — does not alter v1 `holder_yield` Instant path.
module arena::basket_yield;

use arena::errors;
use arena::events;
use std::type_name::{Self, TypeName};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::object::{Self, ID, UID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::TxContext;
use sui::vec_set::{Self, VecSet};

/// Magnified-dividend scalar (1e12). Same as `holder_yield` / `pool::MAG`.
const MAG: u256 = 1_000_000_000_000;
const BPS: u64 = 10_000;
const MAX_ASSETS: u64 = 3;

/// Claim every selected RWA stream in one pull (production TBD).
const PAYOUT_ALL_AT_ONCE: u8 = 0;
/// Claim the cursor asset only; rotate on fund/convert epochs (production TBD).
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

/// Per-address weight + unpaid (quote-normalized placeholder until per-asset
/// pots land). Same registration model as `holder_yield::YieldHolder`.
public struct BasketHolder has store, drop {
    amount: u64,
    debt: u256,
    unpaid: u64,
}

/// Shared basket vault bound 1:1 to an Instadex `BluefinPositionLock`.
/// RWA pots will be DFs on `id` (not laid out here — Compatible-friendly).
public struct BasketYieldVault<phantom T, phantom Q> has key {
    id: UID,
    lock_id: ID,
    bluefin_pool_id: ID,
    config: BasketConfig,
    holders: Table<address, BasketHolder>,
    total_registered: u64,
    /// Pit-bps quote slice before convert into RWA pots.
    quote_staging: Balance<Q>,
    /// Magnified per-share on staging/quote-normalized credits (scaffold).
    mps: u256,
    /// Active index into `config.assets` for `PAYOUT_ROTATING`.
    rotate_index: u64,
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

// === Vault lifecycle ===

/// Create and share a vault. Called once at Instant basket launch (when wired).
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
    };
    let id = object::id(&vault);
    transfer::share_object(vault);
    id
}

/// Stage the pit-bps quote slice. On no holders / zero, returns `fee` for
/// creator residual rescue (same pattern as `holder_yield::try_fund`).
public(package) fun try_fund_quote<T, Q>(
    vault: &mut BasketYieldVault<T, Q>,
    fee: Balance<Q>,
    clock: &Clock,
): Balance<Q> {
    let amount = fee.value();
    if (amount == 0 || vault.total_registered == 0) {
        return fee
    };
    vault.mps = vault.mps + (amount as u256) * MAG / (vault.total_registered as u256);
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

/// Set registry weight to `coin.value()`. Accrues unpaid before the update.
public fun sync_registration<T, Q>(
    vault: &mut BasketYieldVault<T, Q>,
    coin: &Coin<T>,
    ctx: &TxContext,
) {
    let who = ctx.sender();
    let new_amt = coin.value();
    let mps = vault.mps;
    ensure_holder(vault, who);
    let h = vault.holders.borrow_mut(who);
    accure(h, mps);
    let old = h.amount;
    if (new_amt >= old) {
        vault.total_registered = vault.total_registered + (new_amt - old);
    } else {
        vault.total_registered = vault.total_registered - (old - new_amt);
    };
    h.amount = new_amt;
    h.debt = (new_amt as u256) * mps;
}

// === Stubs (next Compatible slice) ===

/// Convert staged `Q` into RWA pots per `BasketConfig` (DEX hop — not implemented).
public fun convert_stub<T, Q>(_vault: &mut BasketYieldVault<T, Q>) {
    abort errors::retired()
}

/// Claim all selected RWA streams (all-at-once mode).
public fun claim_all<T, Q>(_vault: &mut BasketYieldVault<T, Q>, _ctx: &mut TxContext) {
    abort errors::retired()
}

/// Claim the active rotating asset only.
public fun claim_rotating<T, Q>(_vault: &mut BasketYieldVault<T, Q>, _ctx: &mut TxContext) {
    abort errors::retired()
}

/// Advance rotating cursor (keeper / fund hook — not implemented).
public fun advance_rotation_stub<T, Q>(_vault: &mut BasketYieldVault<T, Q>, _clock: &Clock) {
    abort errors::retired()
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

public fun pending_quote_normalized<T, Q>(vault: &BasketYieldVault<T, Q>, who: address): u64 {
    if (!vault.holders.contains(who)) {
        return 0
    };
    let h = vault.holders.borrow(who);
    let accum = (h.amount as u256) * vault.mps;
    let extra = if (accum > h.debt) {
        u256_to_u64((accum - h.debt) / MAG)
    } else {
        0
    };
    h.unpaid + extra
}

fun ensure_holder<T, Q>(vault: &mut BasketYieldVault<T, Q>, who: address) {
    if (!vault.holders.contains(who)) {
        vault.holders.add(who, BasketHolder { amount: 0, debt: 0, unpaid: 0 });
    }
}

fun accure(h: &mut BasketHolder, mps: u256) {
    let accum = (h.amount as u256) * mps;
    if (accum > h.debt) {
        h.unpaid = h.unpaid + u256_to_u64((accum - h.debt) / MAG);
    };
    h.debt = accum;
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
