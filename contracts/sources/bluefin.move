/// Isolated Bluefin Spot CALL wrappers.
///
/// Types (`GlobalConfig`, `Pool`, `Position`) come from the original Bluefin
/// package `0x3492c874…`. The official BluefinSpot interface already CALLs
/// published-at `0xd075338d…` for `create_pool_and_get_object` and friends.
/// Do not add a second named package at `0xd075` (InvalidLinkage on upgrade).
/// Unit tests must never invoke this module.
module arena::bluefin;

use bluefin_spot::pool as bf_pool;
use bluefin_spot::config::{Self as bf_config, GlobalConfig};
use bluefin_spot::position::Position;
use integer_mate::i32;
use sui::balance::Balance;
use sui::clock::Clock;
use sui::object::ID;
use sui::tx_context::TxContext;

/// Volatile SUI meme pool: tick spacing 60, 1% fee (1e6 scale: 10_000 = 1%).
const TICK_SPACING: u32 = 60;
const FEE_RATE: u64 = 10_000;

public(package) fun tick_spacing(): u32 { TICK_SPACING }
public(package) fun fee_rate(): u64 { FEE_RATE }

public(package) fun creation_fee_amount<Fee>(protocol_config: &GlobalConfig): (bool, u64) {
    bf_config::get_pool_creation_fee_amount<Fee>(protocol_config)
}

/// Full-range tick bits from GlobalConfig, snapped inward to `tick_spacing`.
/// Mainnet GlobalConfig `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352`
/// stores min_tick.bits = 4294523660 (−443636) and max_tick.bits = 443636.
public(package) fun full_range_tick_bits(protocol_config: &GlobalConfig): (u32, u32) {
    let (min_tick, max_tick) = bf_config::get_tick_range(protocol_config);
    let spacing = TICK_SPACING;
    (
        arena::math::align_tick_bits(i32::as_u32(min_tick), spacing),
        arena::math::align_tick_bits(i32::as_u32(max_tick), spacing),
    )
}

/// Create a Bluefin pool, seed full-range liquidity, and share the pool.
/// Residuals are returned to the caller (forwarded to the Arena creator).
///
/// `create_pool_and_get_object` + `open_position` + `add_liquidity_with_fixed_amount`
/// + `share_pool_object` so we hold the pool long enough to share it. The
/// combined `create_pool_with_liquidity` entry already shares internally and
/// does not return the pool object.
public(package) fun create_and_seed<CoinA, CoinB, CoinFee>(
    clock: &Clock,
    protocol_config: &mut GlobalConfig,
    pool_name: vector<u8>,
    icon_url: vector<u8>,
    coin_a_symbol: vector<u8>,
    coin_a_decimals: u8,
    coin_a_url: vector<u8>,
    coin_b_symbol: vector<u8>,
    coin_b_decimals: u8,
    coin_b_url: vector<u8>,
    current_sqrt_price: u128,
    creation_fee: Balance<CoinFee>,
    lower_tick_bits: u32,
    upper_tick_bits: u32,
    balance_a: Balance<CoinA>,
    balance_b: Balance<CoinB>,
    amount: u64,
    is_fixed_a: bool,
    ctx: &mut TxContext,
): (ID, Position, u64, u64, Balance<CoinA>, Balance<CoinB>) {
    let mut pool = bf_pool::create_pool_and_get_object<CoinA, CoinB, CoinFee>(
        clock,
        protocol_config,
        pool_name,
        icon_url,
        coin_a_symbol,
        coin_a_decimals,
        coin_a_url,
        coin_b_symbol,
        coin_b_decimals,
        coin_b_url,
        TICK_SPACING,
        FEE_RATE,
        current_sqrt_price,
        creation_fee,
        ctx,
    );
    let mut position = bf_pool::open_position(
        protocol_config,
        &mut pool,
        lower_tick_bits,
        upper_tick_bits,
        ctx,
    );
    let (paid_a, paid_b, rem_a, rem_b) = bf_pool::add_liquidity_with_fixed_amount(
        clock,
        protocol_config,
        &mut pool,
        &mut position,
        balance_a,
        balance_b,
        amount,
        is_fixed_a,
    );
    let pool_id = sui::object::id(&pool);
    bf_pool::share_pool_object(pool);
    (pool_id, position, paid_a, paid_b, rem_a, rem_b)
}
