/// Bonding-curve pool. Constant product over (virtual_quote + real_quote) * token_reserve.
///
/// Ranking metric (pit leader): market-cap estimate
///   (virtual_quote + real_quote) * virtual_token / token_reserve
/// i.e. spot price times initial curve supply.
///
/// Holder registry tracks net bought-through-pool balances only. External Coin<T>
/// transfers do not update it; reflection and pit-holder claims follow the registry,
/// not wallet balances.
module arena::pool;

use arena::config::{Self, Config};
use arena::errors;
use arena::events;
use arena::math;
use arena::pit::{Self, Pit};
use std::ascii::String as AsciiString;
use std::string::String;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin, CoinMetadata, TreasuryCap};
use sui::object::ID;
use sui::object::{Self, UID};
use sui::transfer;
use sui::tx_context::TxContext;
use sui::table::{Self, Table};

/// Magnified-dividend scalar (1e12). Accumulators use u256 so amount * mps cannot wrap u128.
const MAG: u256 = 1_000_000_000_000;
const PIT_HOLDERS: u8 = 0;
const PIT_BUY_AND_BURN: u8 = 1;
const CLAIM_REFLECTION: u8 = 0;
const CLAIM_PIT: u8 = 1;
const CLAIM_CREATOR: u8 = 2;

public struct Holder has store, drop {
    amount: u64,
    refl_debt: u256,
    refl_unpaid: u64,
    pit_debt: u256,
    pit_unpaid: u64,
}

public struct Pool<phantom T, phantom Q> has key {
    id: UID,
    token_reserve: Balance<T>,
    quote_reserve: Balance<Q>,
    virtual_quote: u64,
    /// Initial curve supply; also the numerator of the mcap ranking metric.
    virtual_token: u64,
    /// Cumulative quote that entered the curve after fees (buys + pit burn). Not reduced on sell.
    raised: u64,
    treasury_cap: TreasuryCap<T>,
    reflection: bool,
    pit_mode: u8,
    graduated: bool,
    lp_locked: bool,
    graduation_threshold: u64,
    name: String,
    symbol: AsciiString,
    creator: address,
    created_ms: u64,
    holders: Table<address, Holder>,
    total_registered: u64,
    reflection_pot: Balance<Q>,
    refl_mps: u256,
    pit_claim_pot: Balance<Q>,
    pit_mps: u256,
    creator_pot: Balance<Q>,
}

public(package) fun new<T, Q>(
    treasury_cap: TreasuryCap<T>,
    metadata: &CoinMetadata<T>,
    virtual_quote: u64,
    virtual_token: u64,
    graduation_threshold: u64,
    pit_mode: u8,
    reflection: bool,
    clock: &Clock,
    ctx: &mut TxContext,
): Pool<T, Q> {
    assert!(pit_mode == PIT_HOLDERS || pit_mode == PIT_BUY_AND_BURN, errors::invalid_pit_mode());
    assert!(virtual_token > 0 && virtual_quote > 0, errors::zero_amount());
    let mut cap = treasury_cap;
    let token_reserve = cap.mint_balance(virtual_token);
    Pool<T, Q> {
        id: object::new(ctx),
        token_reserve,
        quote_reserve: balance::zero<Q>(),
        virtual_quote,
        virtual_token,
        raised: 0,
        treasury_cap: cap,
        reflection,
        pit_mode,
        graduated: false,
        lp_locked: false,
        graduation_threshold,
        name: metadata.get_name(),
        symbol: metadata.get_symbol(),
        creator: ctx.sender(),
        created_ms: clock.timestamp_ms(),
        holders: table::new(ctx),
        total_registered: 0,
        reflection_pot: balance::zero<Q>(),
        refl_mps: 0,
        pit_claim_pot: balance::zero<Q>(),
        pit_mps: 0,
        creator_pot: balance::zero<Q>(),
    }
}

/// Spot mcap: (virtual_quote + real_quote) * initial_curve_tokens / token_reserve.
public fun market_cap_metric<T, Q>(pool: &Pool<T, Q>): u64 {
    let token_res = pool.token_reserve.value();
    if (token_res == 0) {
        return 0
    };
    math::mul_div(
        pool.virtual_quote + pool.quote_reserve.value(),
        pool.virtual_token,
        token_res,
    )
}

public fun buy<T, Q>(
    pool: &mut Pool<T, Q>,
    config: &mut Config,
    pit: &mut Pit<Q>,
    mut quote: Coin<Q>,
    min_out: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<T> {
    config::assert_not_paused(config);
    assert!(!pool.graduated, errors::graduated());
    let quote_in = quote.value();
    assert!(quote_in > 0, errors::zero_amount());

    let (creator_fee, platform_fee, pit_fee, refl_fee) =
        config::fee_split(config, pool.reflection, quote_in);
    let curve_in = quote_in - creator_fee - platform_fee - pit_fee - refl_fee;
    assert!(curve_in > 0, errors::zero_amount());

    let quote_amm = pool.virtual_quote + pool.quote_reserve.value();
    let tokens_out = math::get_amount_out(curve_in, quote_amm, pool.token_reserve.value());
    assert!(tokens_out >= min_out, errors::slippage());
    assert!(tokens_out > 0, errors::zero_amount());

    pipe_fees(pool, config, pit, &mut quote, creator_fee, platform_fee, pit_fee, refl_fee, ctx);
    pool.quote_reserve.join(quote.into_balance());
    let out = pool.token_reserve.split(tokens_out);
    pool.raised = pool.raised + curve_in;

    credit_holder(pool, ctx.sender(), tokens_out);
    if (refl_fee > 0) {
        distribute_reflection(pool, refl_fee);
    };

    pit::nudge(
        pit,
        object::id(pool),
        market_cap_metric(pool),
        pool.graduated,
        config.round_ms(),
        clock,
    );

    maybe_graduate(pool);

    events::emit_trade(
        object::id(pool),
        ctx.sender(),
        true,
        curve_in,
        tokens_out,
        pit_fee,
        refl_fee,
        creator_fee,
        platform_fee,
        pool.raised,
        pool.token_reserve.value(),
        pool.quote_reserve.value(),
    );

    coin::from_balance(out, ctx)
}

public fun sell<T, Q>(
    pool: &mut Pool<T, Q>,
    config: &mut Config,
    pit: &mut Pit<Q>,
    tokens: Coin<T>,
    min_out: u64,
    clock: &Clock,
    ctx: &mut TxContext,
): Coin<Q> {
    config::assert_not_paused(config);
    assert!(!pool.graduated, errors::graduated());
    let tokens_in = tokens.value();
    assert!(tokens_in > 0, errors::zero_amount());

    let quote_amm = pool.virtual_quote + pool.quote_reserve.value();
    let mut quote_out = math::get_amount_out(tokens_in, pool.token_reserve.value(), quote_amm);
    let real = pool.quote_reserve.value();
    if (quote_out > real) {
        quote_out = real;
    };
    assert!(quote_out > 0, errors::zero_amount());

    let (creator_fee, platform_fee, pit_fee, refl_fee) =
        config::fee_split(config, pool.reflection, quote_out);
    let user_out = quote_out - creator_fee - platform_fee - pit_fee - refl_fee;
    assert!(user_out >= min_out, errors::slippage());

    pool.token_reserve.join(tokens.into_balance());
    let mut quote_bal = pool.quote_reserve.split(quote_out);
    if (pit_fee > 0) {
        pit::take_fee(pit, quote_bal.split(pit_fee));
    };
    if (creator_fee > 0) {
        pool.creator_pot.join(quote_bal.split(creator_fee));
    };
    if (platform_fee > 0) {
        config::take_platform(config, quote_bal.split(platform_fee));
    };
    if (refl_fee > 0) {
        pool.reflection_pot.join(quote_bal.split(refl_fee));
    };

    debit_holder(pool, ctx.sender(), tokens_in);
    if (refl_fee > 0) {
        distribute_reflection(pool, refl_fee);
    };

    pit::nudge(
        pit,
        object::id(pool),
        market_cap_metric(pool),
        pool.graduated,
        config.round_ms(),
        clock,
    );

    events::emit_trade(
        object::id(pool),
        ctx.sender(),
        false,
        user_out,
        tokens_in,
        pit_fee,
        refl_fee,
        creator_fee,
        platform_fee,
        pool.raised,
        pool.token_reserve.value(),
        pool.quote_reserve.value(),
    );

    coin::from_balance(quote_bal, ctx)
}

fun pipe_fees<T, Q>(
    pool: &mut Pool<T, Q>,
    config: &mut Config,
    pit: &mut Pit<Q>,
    quote: &mut Coin<Q>,
    creator_fee: u64,
    platform_fee: u64,
    pit_fee: u64,
    refl_fee: u64,
    ctx: &mut TxContext,
) {
    if (pit_fee > 0) {
        let fee_coin = quote.split(pit_fee, ctx);
        pit::take_fee(pit, fee_coin.into_balance());
    };
    if (creator_fee > 0) {
        let ccoin = quote.split(creator_fee, ctx);
        pool.creator_pot.join(ccoin.into_balance());
    };
    if (platform_fee > 0) {
        let pcoin = quote.split(platform_fee, ctx);
        config::take_platform(config, pcoin.into_balance());
    };
    if (refl_fee > 0) {
        let rcoin = quote.split(refl_fee, ctx);
        pool.reflection_pot.join(rcoin.into_balance());
    };
}

public fun claim_reflection<T, Q>(pool: &mut Pool<T, Q>, ctx: &mut TxContext): Coin<Q> {
    let amt = take_unpaid(pool, ctx.sender(), CLAIM_REFLECTION);
    events::emit_claim(object::id(pool), ctx.sender(), amt, CLAIM_REFLECTION);
    coin::from_balance(pool.reflection_pot.split(amt), ctx)
}

public fun claim_pit<T, Q>(pool: &mut Pool<T, Q>, ctx: &mut TxContext): Coin<Q> {
    let amt = take_unpaid(pool, ctx.sender(), CLAIM_PIT);
    events::emit_claim(object::id(pool), ctx.sender(), amt, CLAIM_PIT);
    coin::from_balance(pool.pit_claim_pot.split(amt), ctx)
}

public fun claim_creator<T, Q>(pool: &mut Pool<T, Q>, ctx: &mut TxContext): Coin<Q> {
    assert!(ctx.sender() == pool.creator, errors::not_creator());
    let amt = pool.creator_pot.value();
    assert!(amt > 0, errors::nothing_to_claim());
    events::emit_claim(object::id(pool), ctx.sender(), amt, CLAIM_CREATOR);
    coin::from_balance(pool.creator_pot.split(amt), ctx)
}

/// Permissionless freeze once `raised` has crossed the pair threshold.
/// Buys that cross the threshold also call this.
public fun graduate<T, Q>(pool: &mut Pool<T, Q>) {
    assert!(!pool.graduated, errors::graduated());
    assert!(pool.raised >= pool.graduation_threshold, errors::not_graduated());
    do_graduate(pool);
}

/// Winner pool pulls the pit pot: holders mode → magnified dividends; burn mode → curve buy + burn.
public fun settle_pit<T, Q>(pool: &mut Pool<T, Q>, pit: &mut Pit<Q>, ctx: &mut TxContext) {
    let id = object::id(pool);
    if (pool.pit_mode == PIT_HOLDERS) {
        let bal = pit::settle_to_holders(pit, id);
        let amt = bal.value();
        pool.pit_claim_pot.join(bal);
        distribute_pit(pool, amt);
    } else {
        assert!(pool.pit_mode == PIT_BUY_AND_BURN, errors::invalid_pit_mode());
        let bal = pit::settle_burn_quote(pit, id);
        burn_from_pit(pool, bal, ctx);
    }
}

/// Spend quote as a fee-less curve buy and burn the tokens off supply.
public fun burn_from_pit<T, Q>(pool: &mut Pool<T, Q>, quote: Balance<Q>, ctx: &mut TxContext) {
    let qin = quote.value();
    if (qin == 0) {
        quote.destroy_zero();
        return
    };
    let quote_amm = pool.virtual_quote + pool.quote_reserve.value();
    let tokens_out = math::get_amount_out(qin, quote_amm, pool.token_reserve.value());
    pool.quote_reserve.join(quote);
    let burned = pool.token_reserve.split(tokens_out);
    pool.treasury_cap.burn(coin::from_balance(burned, ctx));
    pool.raised = pool.raised + qin;
    maybe_graduate(pool);
}

fun maybe_graduate<T, Q>(pool: &mut Pool<T, Q>) {
    if (!pool.graduated && pool.raised >= pool.graduation_threshold) {
        do_graduate(pool);
    }
}

fun do_graduate<T, Q>(pool: &mut Pool<T, Q>) {
    pool.graduated = true;
    events::emit_graduation(
        object::id(pool),
        pool.raised,
        pool.token_reserve.value(),
        pool.quote_reserve.value(),
    );
}

/// Drain remaining curve balances into the LP time vault. Once only.
public(package) fun take_reserves_for_lock<T, Q>(pool: &mut Pool<T, Q>): (Balance<T>, Balance<Q>) {
    assert!(pool.graduated, errors::not_graduated());
    assert!(!pool.lp_locked, errors::already_locked());
    let t_amt = pool.token_reserve.value();
    let q_amt = pool.quote_reserve.value();
    assert!(t_amt > 0 && q_amt > 0, errors::insufficient_liquidity());
    pool.lp_locked = true;
    (pool.token_reserve.split(t_amt), pool.quote_reserve.split(q_amt))
}

public(package) fun extract_for_lock<T, Q>(
    pool: &mut Pool<T, Q>,
): (Balance<T>, Balance<Q>, ID, address) {
    let id = object::id(pool);
    let creator = pool.creator;
    let (token, quote) = take_reserves_for_lock(pool);
    (token, quote, id, creator)
}

fun distribute_reflection<T, Q>(pool: &mut Pool<T, Q>, amount: u64) {
    if (amount == 0 || pool.total_registered == 0) {
        return
    };
    pool.refl_mps = pool.refl_mps + (amount as u256) * MAG / (pool.total_registered as u256);
}

fun distribute_pit<T, Q>(pool: &mut Pool<T, Q>, amount: u64) {
    if (amount == 0 || pool.total_registered == 0) {
        return
    };
    pool.pit_mps = pool.pit_mps + (amount as u256) * MAG / (pool.total_registered as u256);
}

fun accure(h: &mut Holder, refl_mps: u256, pit_mps: u256) {
    let a = h.amount as u256;
    let refl_accum = a * refl_mps;
    if (refl_accum > h.refl_debt) {
        h.refl_unpaid = h.refl_unpaid + u256_to_u64((refl_accum - h.refl_debt) / MAG);
    };
    h.refl_debt = refl_accum;
    let pit_accum = a * pit_mps;
    if (pit_accum > h.pit_debt) {
        h.pit_unpaid = h.pit_unpaid + u256_to_u64((pit_accum - h.pit_debt) / MAG);
    };
    h.pit_debt = pit_accum;
}

fun ensure_holder<T, Q>(pool: &mut Pool<T, Q>, who: address) {
    if (!pool.holders.contains(who)) {
        pool.holders.add(who, Holder {
            amount: 0,
            refl_debt: 0,
            refl_unpaid: 0,
            pit_debt: 0,
            pit_unpaid: 0,
        });
    }
}

fun credit_holder<T, Q>(pool: &mut Pool<T, Q>, who: address, tokens: u64) {
    let refl_mps = pool.refl_mps;
    let pit_mps = pool.pit_mps;
    pool.total_registered = pool.total_registered + tokens;
    ensure_holder(pool, who);
    let h = pool.holders.borrow_mut(who);
    accure(h, refl_mps, pit_mps);
    h.amount = h.amount + tokens;
    h.refl_debt = (h.amount as u256) * refl_mps;
    h.pit_debt = (h.amount as u256) * pit_mps;
}

fun debit_holder<T, Q>(pool: &mut Pool<T, Q>, who: address, tokens: u64) {
    if (!pool.holders.contains(who)) {
        return
    };
    let refl_mps = pool.refl_mps;
    let pit_mps = pool.pit_mps;
    let mut reduce = 0;
    {
        let h = pool.holders.borrow_mut(who);
        accure(h, refl_mps, pit_mps);
        reduce = if (h.amount >= tokens) { tokens } else { h.amount };
        h.amount = h.amount - reduce;
        h.refl_debt = (h.amount as u256) * refl_mps;
        h.pit_debt = (h.amount as u256) * pit_mps;
    };
    pool.total_registered = pool.total_registered - reduce;
}

fun take_unpaid<T, Q>(pool: &mut Pool<T, Q>, who: address, kind: u8): u64 {
    assert!(pool.holders.contains(who), errors::nothing_to_claim());
    let refl_mps = pool.refl_mps;
    let pit_mps = pool.pit_mps;
    let h = pool.holders.borrow_mut(who);
    accure(h, refl_mps, pit_mps);
    let amt = if (kind == CLAIM_REFLECTION) {
        let a = h.refl_unpaid;
        h.refl_unpaid = 0;
        a
    } else {
        let a = h.pit_unpaid;
        h.pit_unpaid = 0;
        a
    };
    assert!(amt > 0, errors::nothing_to_claim());
    amt
}

fun u256_to_u64(x: u256): u64 {
    assert!(x <= 18446744073709551615u256, errors::overflow());
    x as u64
}

public fun raised<T, Q>(pool: &Pool<T, Q>): u64 { pool.raised }
public fun token_reserves<T, Q>(pool: &Pool<T, Q>): u64 { pool.token_reserve.value() }
public fun quote_reserves<T, Q>(pool: &Pool<T, Q>): u64 { pool.quote_reserve.value() }
public fun is_graduated<T, Q>(pool: &Pool<T, Q>): bool { pool.graduated }
public fun is_lp_locked<T, Q>(pool: &Pool<T, Q>): bool { pool.lp_locked }
public fun lp_locked<T, Q>(pool: &Pool<T, Q>): bool { pool.lp_locked }
public fun pit_mode<T, Q>(pool: &Pool<T, Q>): u8 { pool.pit_mode }
public fun is_reflection<T, Q>(pool: &Pool<T, Q>): bool { pool.reflection }
public fun total_registered<T, Q>(pool: &Pool<T, Q>): u64 { pool.total_registered }
public fun virtual_quote<T, Q>(pool: &Pool<T, Q>): u64 { pool.virtual_quote }
public fun virtual_token<T, Q>(pool: &Pool<T, Q>): u64 { pool.virtual_token }
public fun total_supply<T, Q>(pool: &Pool<T, Q>): u64 { pool.treasury_cap.total_supply() }
public fun creator<T, Q>(pool: &Pool<T, Q>): address { pool.creator }
public fun name<T, Q>(pool: &Pool<T, Q>): String { pool.name }
public fun symbol<T, Q>(pool: &Pool<T, Q>): AsciiString { pool.symbol }
public fun creator_pot_value<T, Q>(pool: &Pool<T, Q>): u64 { pool.creator_pot.value() }

public fun holder_amount<T, Q>(pool: &Pool<T, Q>, who: address): u64 {
    if (!pool.holders.contains(who)) {
        0
    } else {
        pool.holders.borrow(who).amount
    }
}

public fun id<T, Q>(pool: &Pool<T, Q>): ID { object::id(pool) }

public(package) fun share<T, Q>(pool: Pool<T, Q>) {
    transfer::share_object(pool)
}

public fun pit_holders(): u8 { PIT_HOLDERS }
public fun pit_buy_and_burn(): u8 { PIT_BUY_AND_BURN }
