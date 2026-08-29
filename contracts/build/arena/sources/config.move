/// Shared protocol parameters, SUI treasury, and AdminCap.
/// Init shares Config plus Pit<SUI>. Create Pit<XAUM> after publish via pit::create_pit.
module arena::config;

use arena::errors;
use arena::pit;
use std::type_name;
use sui::balance::{Self, Balance};
use sui::coin::Coin;
use sui::sui::SUI;
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::TxContext;

const DEFAULT_LAUNCH_FEE_SUI: u64 = 1_000_000_000;
const DEFAULT_PIT_BPS: u64 = 100;
const DEFAULT_REFLECTION_BPS: u64 = 200;
const DEFAULT_GRADUATION_SUI: u64 = 2_000 * 1_000_000_000;
const DEFAULT_GRADUATION_XAUM: u64 = 1_000_000_000; // 1 XAUM
const DEFAULT_VIRTUAL_QUOTE_SUI: u64 = 30_000_000_000;
const DEFAULT_VIRTUAL_QUOTE_XAUM: u64 = 100_000_000; // 0.1 XAUM
const DEFAULT_VIRTUAL_TOKEN: u64 = 800_000_000 * 1_000_000_000;
const DEFAULT_ROUND_MS: u64 = 86_400_000;
const BPS: u64 = 10_000;

public struct AdminCap has key, store {
    id: UID,
}

public struct Config has key {
    id: UID,
    launch_fee_sui: u64,
    pit_bps: u64,
    reflection_bps: u64,
    graduation_sui: u64,
    graduation_xaum: u64,
    virtual_quote_sui: u64,
    virtual_quote_xaum: u64,
    virtual_token: u64,
    round_ms: u64,
    treasury: Balance<SUI>,
    paused: bool,
}

fun init(ctx: &mut TxContext) {
    let admin = AdminCap { id: object::new(ctx) };
    transfer::transfer(admin, ctx.sender());

    transfer::share_object(Config {
        id: object::new(ctx),
        launch_fee_sui: DEFAULT_LAUNCH_FEE_SUI,
        pit_bps: DEFAULT_PIT_BPS,
        reflection_bps: DEFAULT_REFLECTION_BPS,
        graduation_sui: DEFAULT_GRADUATION_SUI,
        graduation_xaum: DEFAULT_GRADUATION_XAUM,
        virtual_quote_sui: DEFAULT_VIRTUAL_QUOTE_SUI,
        virtual_quote_xaum: DEFAULT_VIRTUAL_QUOTE_XAUM,
        virtual_token: DEFAULT_VIRTUAL_TOKEN,
        round_ms: DEFAULT_ROUND_MS,
        treasury: balance::zero<SUI>(),
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

public fun launch_fee_sui(config: &Config): u64 { config.launch_fee_sui }
public fun pit_bps(config: &Config): u64 { config.pit_bps }
public fun reflection_bps(config: &Config): u64 { config.reflection_bps }
public fun graduation_sui(config: &Config): u64 { config.graduation_sui }
public fun graduation_xaum(config: &Config): u64 { config.graduation_xaum }
public fun virtual_quote_sui(config: &Config): u64 { config.virtual_quote_sui }
public fun virtual_quote_xaum(config: &Config): u64 { config.virtual_quote_xaum }
public fun virtual_token(config: &Config): u64 { config.virtual_token }
public fun round_ms(config: &Config): u64 { config.round_ms }
public fun paused(config: &Config): bool { config.paused }
public fun treasury_value(config: &Config): u64 { config.treasury.value() }

public fun set_paused(config: &mut Config, _: &AdminCap, paused: bool) {
    config.paused = paused;
}

public fun set_launch_fee_sui(config: &mut Config, _: &AdminCap, v: u64) {
    config.launch_fee_sui = v;
}

public fun set_pit_bps(config: &mut Config, _: &AdminCap, v: u64) {
    assert!(v <= BPS, errors::invalid_fee());
    config.pit_bps = v;
}

public fun set_reflection_bps(config: &mut Config, _: &AdminCap, v: u64) {
    assert!(v <= BPS, errors::invalid_fee());
    config.reflection_bps = v;
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

/// Tiny defaults used by unit tests (fee 1_000, graduation 50_000, …).
#[test_only]
public fun set_for_testing(
    config: &mut Config,
    launch_fee_sui: u64,
    pit_bps: u64,
    reflection_bps: u64,
    graduation_sui: u64,
    graduation_xaum: u64,
    virtual_quote_sui: u64,
    virtual_quote_xaum: u64,
    virtual_token: u64,
    round_ms: u64,
) {
    config.launch_fee_sui = launch_fee_sui;
    config.pit_bps = pit_bps;
    config.reflection_bps = reflection_bps;
    config.graduation_sui = graduation_sui;
    config.graduation_xaum = graduation_xaum;
    config.virtual_quote_sui = virtual_quote_sui;
    config.virtual_quote_xaum = virtual_quote_xaum;
    config.virtual_token = virtual_token;
    config.round_ms = round_ms;
}
