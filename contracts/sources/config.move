/// Shared protocol parameters, SUI treasury, platform quote bag, and AdminCap.
/// Init shares Config plus Pit<SUI>. Create Pit<XAUM> after publish via pit::create_pit.
/// AdminCap (launch + platform fee withdraws, param sets) is sent to the Odyssey
/// launchpad platform wallet so Arena and Odyssey share one treasury.
module arena::config;

use arena::errors;
use arena::math;
use arena::pit::{Self, Pit};
use std::type_name;
use sui::bag::{Self, Bag};
use sui::balance::{Self, Balance};
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use sui::sui::SUI;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;

const DEFAULT_LAUNCH_FEE_SUI: u64 = 1_000_000_000;
const DEFAULT_SWAP_FEE_BPS: u64 = 100;
const DEFAULT_STD_CREATOR_BPS: u64 = 6_000;
const DEFAULT_STD_PLATFORM_BPS: u64 = 1_000;
const DEFAULT_STD_PIT_BPS: u64 = 3_000;
const DEFAULT_REFL_REFLECTION_BPS: u64 = 5_000;
const DEFAULT_REFL_CREATOR_BPS: u64 = 2_000;
const DEFAULT_REFL_PIT_BPS: u64 = 2_000;
const DEFAULT_REFL_PLATFORM_BPS: u64 = 1_000;
const DEFAULT_GRADUATION_SUI: u64 = 2_000 * 1_000_000_000;
const DEFAULT_GRADUATION_XAUM: u64 = 1_000_000_000; // 1 XAUM
const DEFAULT_VIRTUAL_QUOTE_SUI: u64 = 30_000_000_000;
const DEFAULT_VIRTUAL_QUOTE_XAUM: u64 = 100_000_000; // 0.1 XAUM
const DEFAULT_VIRTUAL_TOKEN: u64 = 800_000_000 * 1_000_000_000;
const DEFAULT_ROUND_MS: u64 = 86_400_000;
/// 180 days.
const DEFAULT_LP_LOCK_MS: u64 = 15_552_000_000;
const BPS: u64 = 10_000;
/// Same platform wallet as The Odyssey on Sui launchpad.
const PLATFORM_WALLET: address = @0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b;

public struct AdminCap has key, store {
    id: UID,
}

public struct StoredQuote<phantom Q> has store {
    inner: Balance<Q>,
}

/// Dynamic-field key on Config for the official `Pit<Q>` object id.
/// Compatible upgrade: no new Config field; AdminCap registers after publish.
public struct OfficialPitKey<phantom Q> has copy, drop, store {}

/// Dynamic-field key for Instant virtual quote (price only; 0 real quote is deposited).
public struct InstantVirtualQuoteKey<phantom Q> has copy, drop, store {}

const DEFAULT_INSTANT_VIRTUAL_SUI: u64 = 1_000_000_000;
const DEFAULT_INSTANT_VIRTUAL_XAUM: u64 = 10_000_000;

public struct Config has key {
    id: UID,
    launch_fee_sui: u64,
    swap_fee_bps: u64,
    std_creator_bps: u64,
    std_platform_bps: u64,
    std_pit_bps: u64,
    refl_reflection_bps: u64,
    refl_creator_bps: u64,
    refl_pit_bps: u64,
    refl_platform_bps: u64,
    graduation_sui: u64,
    graduation_xaum: u64,
    virtual_quote_sui: u64,
    virtual_quote_xaum: u64,
    virtual_token: u64,
    round_ms: u64,
    lp_lock_ms: u64,
    treasury: Balance<SUI>,
    platform: Bag,
    paused: bool,
}

fun init(ctx: &mut TxContext) {
    let admin = AdminCap { id: object::new(ctx) };
    transfer::transfer(admin, PLATFORM_WALLET);

    transfer::share_object(Config {
        id: object::new(ctx),
        launch_fee_sui: DEFAULT_LAUNCH_FEE_SUI,
        swap_fee_bps: DEFAULT_SWAP_FEE_BPS,
        std_creator_bps: DEFAULT_STD_CREATOR_BPS,
        std_platform_bps: DEFAULT_STD_PLATFORM_BPS,
        std_pit_bps: DEFAULT_STD_PIT_BPS,
        refl_reflection_bps: DEFAULT_REFL_REFLECTION_BPS,
        refl_creator_bps: DEFAULT_REFL_CREATOR_BPS,
        refl_pit_bps: DEFAULT_REFL_PIT_BPS,
        refl_platform_bps: DEFAULT_REFL_PLATFORM_BPS,
        graduation_sui: DEFAULT_GRADUATION_SUI,
        graduation_xaum: DEFAULT_GRADUATION_XAUM,
        virtual_quote_sui: DEFAULT_VIRTUAL_QUOTE_SUI,
        virtual_quote_xaum: DEFAULT_VIRTUAL_QUOTE_XAUM,
        virtual_token: DEFAULT_VIRTUAL_TOKEN,
        round_ms: DEFAULT_ROUND_MS,
        lp_lock_ms: DEFAULT_LP_LOCK_MS,
        treasury: balance::zero<SUI>(),
        platform: bag::new(ctx),
        paused: false,
    });

    pit::create_and_share<SUI>(ctx);
    // Pit<XAUM> is created post-publish with pit::create_pit<XAUM>
}

public fun take_launch_fee(config: &mut Config, fee: Coin<SUI>) {
    assert!(!config.paused, errors::paused());
    assert!(fee.value() == config.launch_fee_sui, errors::invalid_fee());
    config.treasury.join(fee.into_balance());
}

/// `(creator, platform, pit, refl)` split of `swap_fee_bps` on `quote_amount`.
/// Standard: 60/10/30 creator/platform/pit. Reflection: 50/20/20/10 refl/creator/pit/platform.
public fun fee_split(config: &Config, reflection: bool, quote_amount: u64): (u64, u64, u64, u64) {
    let fee = math::mul_div(quote_amount, config.swap_fee_bps, BPS);
    if (reflection) {
        let creator = math::mul_div(fee, config.refl_creator_bps, BPS);
        let platform = math::mul_div(fee, config.refl_platform_bps, BPS);
        let pit = math::mul_div(fee, config.refl_pit_bps, BPS);
        let refl = math::mul_div(fee, config.refl_reflection_bps, BPS);
        (creator, platform, pit, refl)
    } else {
        let creator = math::mul_div(fee, config.std_creator_bps, BPS);
        let platform = math::mul_div(fee, config.std_platform_bps, BPS);
        let pit = math::mul_div(fee, config.std_pit_bps, BPS);
        (creator, platform, pit, 0)
    }
}

fun set_official_pit<Q>(config: &mut Config, pit_id: ID) {
    let key = OfficialPitKey<Q> {};
    if (df::exists(&config.id, key)) {
        *df::borrow_mut(&mut config.id, key) = pit_id;
    } else {
        df::add(&mut config.id, key, pit_id);
    }
}

/// Bind `Pit<Q>` as the only pit `collect_instadex_fees` may credit. AdminCap.
public fun register_pit<Q>(config: &mut Config, _: &AdminCap, pit: &Pit<Q>) {
    set_official_pit<Q>(config, object::id(pit));
}

public fun official_pit_id<Q>(config: &Config): ID {
    let key = OfficialPitKey<Q> {};
    assert!(df::exists(&config.id, key), errors::pit_not_registered());
    *df::borrow(&config.id, key)
}

public fun assert_official_pit<Q>(config: &Config, pit: &Pit<Q>) {
    assert!(object::id(pit) == official_pit_id<Q>(config), errors::wrong_pit());
}

/// Virtual quote used only to pick Instant sqrt-price / tick. No real quote is deposited.
public fun instant_virtual_quote<Q>(config: &Config): u64 {
    let key = InstantVirtualQuoteKey<Q> {};
    if (df::exists(&config.id, key)) {
        *df::borrow(&config.id, key)
    } else if (type_name::with_defining_ids<Q>() == type_name::with_defining_ids<SUI>()) {
        DEFAULT_INSTANT_VIRTUAL_SUI
    } else {
        DEFAULT_INSTANT_VIRTUAL_XAUM
    }
}

public fun set_instant_virtual_quote<Q>(config: &mut Config, _: &AdminCap, v: u64) {
    assert!(v > 0, errors::zero_amount());
    let key = InstantVirtualQuoteKey<Q> {};
    if (df::exists(&config.id, key)) {
        *df::borrow_mut(&mut config.id, key) = v;
    } else {
        df::add(&mut config.id, key, v);
    }
}

public fun take_platform<Q>(config: &mut Config, fee: Balance<Q>) {
    if (fee.value() == 0) {
        fee.destroy_zero();
        return
    };
    let key = type_name::with_defining_ids<Q>();
    if (config.platform.contains(key)) {
        let stored: &mut StoredQuote<Q> = config.platform.borrow_mut(key);
        stored.inner.join(fee);
    } else {
        config.platform.add(key, StoredQuote { inner: fee });
    }
}

public fun withdraw_platform<Q>(
    config: &mut Config,
    _: &AdminCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Q> {
    let key = type_name::with_defining_ids<Q>();
    let stored: &mut StoredQuote<Q> = config.platform.borrow_mut(key);
    coin::from_balance(stored.inner.split(amount), ctx)
}

public fun platform_value<Q>(config: &Config): u64 {
    let key = type_name::with_defining_ids<Q>();
    if (!config.platform.contains(key)) {
        0
    } else {
        let stored: &StoredQuote<Q> = config.platform.borrow(key);
        stored.inner.value()
    }
}

/// `(virtual_quote, graduation_threshold)` for quote type `Q`.
/// SUI uses the SUI pair params; every other quote (XAUM on Bluefin, ticker XAUM not GOLD) uses the xaum params.
public fun quote_params<Q>(config: &Config): (u64, u64) {
    if (type_name::with_defining_ids<Q>() == type_name::with_defining_ids<SUI>()) {
        (config.virtual_quote_sui, config.graduation_sui)
    } else {
        (config.virtual_quote_xaum, config.graduation_xaum)
    }
}

public fun assert_not_paused(config: &Config) {
    assert!(!config.paused, errors::paused());
}

public fun platform_wallet(): address { PLATFORM_WALLET }

public fun launch_fee_sui(config: &Config): u64 { config.launch_fee_sui }
public fun swap_fee_bps(config: &Config): u64 { config.swap_fee_bps }
public fun std_creator_bps(config: &Config): u64 { config.std_creator_bps }
public fun std_platform_bps(config: &Config): u64 { config.std_platform_bps }
public fun std_pit_bps(config: &Config): u64 { config.std_pit_bps }
public fun refl_reflection_bps(config: &Config): u64 { config.refl_reflection_bps }
public fun refl_creator_bps(config: &Config): u64 { config.refl_creator_bps }
public fun refl_pit_bps(config: &Config): u64 { config.refl_pit_bps }
public fun refl_platform_bps(config: &Config): u64 { config.refl_platform_bps }
public fun graduation_sui(config: &Config): u64 { config.graduation_sui }
public fun graduation_xaum(config: &Config): u64 { config.graduation_xaum }
public fun virtual_quote_sui(config: &Config): u64 { config.virtual_quote_sui }
public fun virtual_quote_xaum(config: &Config): u64 { config.virtual_quote_xaum }
public fun virtual_token(config: &Config): u64 { config.virtual_token }
public fun round_ms(config: &Config): u64 { config.round_ms }
public fun lp_lock_ms(config: &Config): u64 { config.lp_lock_ms }
public fun paused(config: &Config): bool { config.paused }
public fun treasury_value(config: &Config): u64 { config.treasury.value() }

public fun set_paused(config: &mut Config, _: &AdminCap, paused: bool) {
    config.paused = paused;
}

public fun set_launch_fee_sui(config: &mut Config, _: &AdminCap, v: u64) {
    config.launch_fee_sui = v;
}

public fun set_swap_fee_bps(config: &mut Config, _: &AdminCap, v: u64) {
    assert!(v <= BPS, errors::invalid_fee());
    config.swap_fee_bps = v;
}

public fun set_std_split(
    config: &mut Config,
    _: &AdminCap,
    creator_bps: u64,
    platform_bps: u64,
    pit_bps: u64,
) {
    assert!(creator_bps + platform_bps + pit_bps == BPS, errors::invalid_fee());
    config.std_creator_bps = creator_bps;
    config.std_platform_bps = platform_bps;
    config.std_pit_bps = pit_bps;
}

public fun set_refl_split(
    config: &mut Config,
    _: &AdminCap,
    reflection_bps: u64,
    creator_bps: u64,
    pit_bps: u64,
    platform_bps: u64,
) {
    assert!(reflection_bps + creator_bps + pit_bps + platform_bps == BPS, errors::invalid_fee());
    config.refl_reflection_bps = reflection_bps;
    config.refl_creator_bps = creator_bps;
    config.refl_pit_bps = pit_bps;
    config.refl_platform_bps = platform_bps;
}

public fun set_graduation_sui(config: &mut Config, _: &AdminCap, v: u64) {
    config.graduation_sui = v;
}

public fun set_graduation_xaum(config: &mut Config, _: &AdminCap, v: u64) {
    config.graduation_xaum = v;
}

public fun set_virtual_quote_sui(config: &mut Config, _: &AdminCap, v: u64) {
    config.virtual_quote_sui = v;
}

public fun set_virtual_quote_xaum(config: &mut Config, _: &AdminCap, v: u64) {
    config.virtual_quote_xaum = v;
}

public fun set_virtual_token(config: &mut Config, _: &AdminCap, v: u64) {
    config.virtual_token = v;
}

public fun set_round_ms(config: &mut Config, _: &AdminCap, v: u64) {
    config.round_ms = v;
}

public fun set_lp_lock_ms(config: &mut Config, _: &AdminCap, v: u64) {
    config.lp_lock_ms = v;
}

public fun withdraw_treasury(
    config: &mut Config,
    _: &AdminCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<SUI> {
    sui::coin::from_balance(config.treasury.split(amount), ctx)
}

#[test_only]
public fun init_for_testing(ctx: &mut TxContext) {
    init(ctx)
}

#[test_only]
public fun register_pit_for_testing<Q>(config: &mut Config, pit: &Pit<Q>) {
    set_official_pit<Q>(config, object::id(pit));
}

#[test_only]
public fun set_official_pit_id_for_testing<Q>(config: &mut Config, pit_id: ID) {
    set_official_pit<Q>(config, pit_id);
}

/// Tiny defaults used by unit tests (fee 1_000, swap 100 bps, graduation 50_000, …).
#[test_only]
public fun set_for_testing(
    config: &mut Config,
    launch_fee_sui: u64,
    swap_fee_bps: u64,
    graduation_sui: u64,
    graduation_xaum: u64,
    virtual_quote_sui: u64,
    virtual_quote_xaum: u64,
    virtual_token: u64,
    round_ms: u64,
) {
    config.launch_fee_sui = launch_fee_sui;
    config.swap_fee_bps = swap_fee_bps;
    config.graduation_sui = graduation_sui;
    config.graduation_xaum = graduation_xaum;
    config.virtual_quote_sui = virtual_quote_sui;
    config.virtual_quote_xaum = virtual_quote_xaum;
    config.virtual_token = virtual_token;
    config.round_ms = round_ms;
}
