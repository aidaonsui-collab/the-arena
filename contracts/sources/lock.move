/// Time vault for graduated bonding-curve liquidity.
///
/// Two production-adjacent paths:
/// 1. `lock_graduated_lp` — raw remaining `token_reserve` + `quote_reserve` into a
///    shared `LpLock<T, Q>`. Kept for tests and as a fallback.
/// 2. `seed_and_lock_bluefin` / `seed_and_lock_bluefin_with_fee` — production path.
///    Permissionless after graduation: drain curve reserves, create a Bluefin Spot
///    pool, seed full-range liquidity at the curve spot, share the pool, and
///    time-lock the Bluefin Position NFT to the Arena creator for `Config.lp_lock_ms`
///    (default 180 days).
/// 3. Instadex (`launch::launch_instadex`) reuses `seed_and_lock_internal` with no
///    Arena `Pool`. `unlock_ms = 0` (permanent; claim aborts). Fees via `launch::collect_instadex_fees`.
///
/// Graduate PTB (SUI quote):
///   Pool<T, SUI>, Config, Clock, Bluefin GlobalConfig,
///   CoinMetadata<T>, CoinMetadata<SUI>
/// Graduate PTB (XAUM quote):
///   Pool<T, XAUM>, Config, Clock, Bluefin GlobalConfig,
///   CoinMetadata<T>, CoinMetadata<XAUM>, Coin<SUI> creation fee
module arena::lock;

use arena::bluefin;
use arena::config::{Self, Config};
use arena::errors;
use arena::events;
use arena::math;
use arena::pit::{Self, Pit};
use arena::pool::{Self, Pool};
use bluefin_spot::config::GlobalConfig;
use bluefin_spot::position::Position;
use std::option::{Self, Option};
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin, CoinMetadata};
use sui::object::{Self, ID, UID};
use sui::sui::SUI;
use sui::transfer;
use sui::tx_context::TxContext;
use sui::url;

const BPS: u64 = 10_000;

public struct LpLock<phantom T, phantom Q> has key {
    id: UID,
    pool_id: ID,
    token: Balance<T>,
    quote: Balance<Q>,
    beneficiary: address,
    unlock_ms: u64,
}

/// Shared vault holding the Bluefin Position NFT. `unlock_ms == 0` means permanent.
public struct BluefinPositionLock has key {
    id: UID,
    pool_id: ID,
    bluefin_pool_id: ID,
    position: Option<Position>,
    beneficiary: address,
    unlock_ms: u64,
}

/// Permissionless. Moves remaining curve balances into a shared vault. Once only.
/// Fallback / test path — production calls `seed_and_lock_bluefin*`.
public fun lock_graduated_lp<T, Q>(
    pool: &mut Pool<T, Q>,
    config: &Config,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    let pool_id = object::id(pool);
    let beneficiary = pool.creator();
    let (token, quote) = pool::take_reserves_for_lock(pool);
    let token_amount = token.value();
    let quote_amount = quote.value();
    let unlock_ms = clock.timestamp_ms() + config.lp_lock_ms();
    let lock = LpLock<T, Q> {
        id: object::new(ctx),
        pool_id,
        token,
        quote,
        beneficiary,
        unlock_ms,
    };
    events::emit_lock(
        object::id(&lock),
        pool_id,
        beneficiary,
        unlock_ms,
        token_amount,
        quote_amount,
    );
    transfer::share_object(lock);
}

/// Beneficiary-only. Returns remaining token and quote after `unlock_ms`.
public fun claim_lp<T, Q>(
    lock: &mut LpLock<T, Q>,
    clock: &Clock,
    ctx: &mut TxContext,
): (Coin<T>, Coin<Q>) {
    assert!(clock.timestamp_ms() >= lock.unlock_ms, errors::still_locked());
    assert!(ctx.sender() == lock.beneficiary, errors::not_beneficiary());
    let token_amount = lock.token.value();
    let quote_amount = lock.quote.value();
    assert!(token_amount > 0 || quote_amount > 0, errors::nothing_to_claim());
    let token = lock.token.split(token_amount);
    let quote = lock.quote.split(quote_amount);
    events::emit_lp_claim(
        object::id(lock),
        lock.pool_id,
        ctx.sender(),
        token_amount,
        quote_amount,
    );
    (coin::from_balance(token, ctx), coin::from_balance(quote, ctx))
}

/// Production path for Q = SUI. Permissionless after graduation.
/// Takes the Bluefin pool-creation fee from `quote_reserve` (aborts if short),
/// seeds a Bluefin Spot pool, shares it, and time-locks the Position NFT.
public fun seed_and_lock_bluefin<T>(
    pool: &mut Pool<T, SUI>,
    config: &Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<SUI>,
    ctx: &mut TxContext,
) {
    let (supported, fee_amt) = bluefin::creation_fee_amount<SUI>(bf_config);
    assert!(supported, errors::invalid_fee());
    let virtual_quote = pool.virtual_quote();
    let token_res = pool.token_reserves();
    let quote_res = pool.quote_reserves();
    assert!(quote_res > fee_amt, errors::insufficient_liquidity());
    let sqrt_p = math::sqrt_price_x64(token_res, virtual_quote + quote_res);
    let (token, mut quote) = pool::take_reserves_for_lock(pool);
    let fee = quote.split(fee_amt);
    let (_lock_id, _bf, _pos, _ms) = seed_and_lock_internal(
        object::id(pool),
        pool.creator(),
        clock.timestamp_ms() + config.lp_lock_ms(),
        clock,
        bf_config,
        meta_t,
        meta_q,
        fee,
        token,
        quote,
        sqrt_p,
        ctx,
    );
}

/// Production path when Q is not SUI (XAUM). `creation_fee` is extra SUI paid
/// to Bluefin; curve quote stays in the LP.
public fun seed_and_lock_bluefin_with_fee<T, Q>(
    pool: &mut Pool<T, Q>,
    config: &Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    creation_fee: Coin<SUI>,
    ctx: &mut TxContext,
) {
    let fee = take_creation_fee(bf_config, creation_fee, ctx.sender(), ctx);
    let virtual_quote = pool.virtual_quote();
    let token_res = pool.token_reserves();
    let quote_res = pool.quote_reserves();
    let sqrt_p = math::sqrt_price_x64(token_res, virtual_quote + quote_res);
    let (token, quote) = pool::take_reserves_for_lock(pool);
    let (_lock_id, _bf, _pos, _ms) = seed_and_lock_internal(
        object::id(pool),
        pool.creator(),
        clock.timestamp_ms() + config.lp_lock_ms(),
        clock,
        bf_config,
        meta_t,
        meta_q,
        fee,
        token,
        quote,
        sqrt_p,
        ctx,
    );
}

/// Split Bluefin's pool-creation fee from `creation_fee`. Leftover coin goes to `sender`.
public(package) fun take_creation_fee(
    bf_config: &GlobalConfig,
    creation_fee: Coin<SUI>,
    sender: address,
    ctx: &mut TxContext,
): Balance<SUI> {
    let (supported, fee_amt) = bluefin::creation_fee_amount<SUI>(bf_config);
    assert!(supported, errors::invalid_fee());
    assert!(creation_fee.value() >= fee_amt, errors::invalid_fee());
    let mut fee_coin = creation_fee;
    let fee = if (fee_amt == 0) {
        sui::balance::zero<SUI>()
    } else {
        fee_coin.split(fee_amt, ctx).into_balance()
    };
    send_residual_coin(fee_coin, sender);
    fee
}

/// Create + seed a Bluefin Spot pool and vault the Position NFT.
/// `pool_id` is the Arena curve pool, or `@0x0` for Instadex (no curve). unlock_ms 0 is permanent.
public(package) fun seed_and_lock_internal<T, Q>(
    pool_id: ID,
    beneficiary: address,
    unlock_ms: u64,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    creation_fee: Balance<SUI>,
    token: Balance<T>,
    quote: Balance<Q>,
    sqrt_price: u128,
    ctx: &mut TxContext,
): (ID, ID, ID, u64) {
    let token_amount = token.value();
    let quote_amount = quote.value();
    assert!(token_amount > 0 && quote_amount > 0, errors::insufficient_liquidity());

    let (lower_bits, upper_bits) = bluefin::full_range_tick_bits(bf_config);
    let mut name = *meta_t.get_symbol().as_bytes();
    name.append(b"-");
    name.append(*meta_q.get_symbol().as_bytes());

    // Fix quote (Coin B) because curve spot includes virtual_quote, so real
    // quote is the scarce side for a full-range seed at that price.
    let (bf_pool_id, position, _paid_a, _paid_b, rem_a, rem_b) =
        bluefin::create_and_seed<T, Q, SUI>(
            clock,
            bf_config,
            name,
            metadata_url(meta_t),
            *meta_t.get_symbol().as_bytes(),
            meta_t.get_decimals(),
            metadata_url(meta_t),
            *meta_q.get_symbol().as_bytes(),
            meta_q.get_decimals(),
            metadata_url(meta_q),
            sqrt_price,
            creation_fee,
            lower_bits,
            upper_bits,
            token,
            quote,
            quote_amount,
            false,
            ctx,
        );

    send_residual(rem_a, beneficiary, ctx);
    send_residual(rem_b, beneficiary, ctx);

    let position_id = object::id(&position);
    let lock = BluefinPositionLock {
        id: object::new(ctx),
        pool_id,
        bluefin_pool_id: bf_pool_id,
        position: option::some(position),
        beneficiary,
        unlock_ms,
    };
    let lock_id = object::id(&lock);
    // Curve path only. Instadex (unlock_ms == 0) emits InstadexLaunchEvent instead.
    if (unlock_ms != 0) {
        events::emit_bluefin_lock(
            lock_id,
            pool_id,
            beneficiary,
            unlock_ms,
            token_amount,
            quote_amount,
            bf_pool_id,
            position_id,
        );
    };
    transfer::share_object(lock);
    (lock_id, bf_pool_id, position_id, unlock_ms)
}

/// Creator claims the Bluefin Position NFT after `unlock_ms`.
public fun claim_bluefin_position(
    lock: &mut BluefinPositionLock,
    clock: &Clock,
    ctx: &mut TxContext,
): Position {
    assert!(lock.unlock_ms != 0, errors::still_locked());
    assert!(clock.timestamp_ms() >= lock.unlock_ms, errors::still_locked());
    assert!(ctx.sender() == lock.beneficiary, errors::not_beneficiary());
    assert!(lock.position.is_some(), errors::nothing_to_claim());
    let position = option::extract(&mut lock.position);
    events::emit_lp_claim(object::id(lock), lock.pool_id, ctx.sender(), 0, 0);
    position
}

/// Split already-collected LP quote by Config.std_* bps.
/// Does **not** apply `swap_fee_bps` — the collected balances are already fees.
/// Remainder dust from integer division goes to creator so the three amounts sum.
public(package) fun split_std_lp_quote(
    amount: u64,
    creator_bps: u64,
    platform_bps: u64,
    pit_bps: u64,
): (u64, u64, u64) {
    let mut creator = math::mul_div(amount, creator_bps, BPS);
    let platform = math::mul_div(amount, platform_bps, BPS);
    let pit = math::mul_div(amount, pit_bps, BPS);
    creator = creator + (amount - creator - platform - pit);
    (creator, platform, pit)
}

/// Collect Bluefin LP fees, split quote B 60/10/30 (creator/platform/pit),
/// send quote remainder to the beneficiary, and return token A for the caller
/// to burn (Instadex) instead of paying it to the creator. NFT stays vaulted.
public(package) fun collect_lp_fees_return_token<A, B>(
    lock: &mut BluefinPositionLock,
    clock: &Clock,
    bf_config: &GlobalConfig,
    bf_pool: &mut bluefin_spot::pool::Pool<A, B>,
    config: &mut Config,
    pit: &mut Pit<B>,
    ctx: &mut TxContext,
): Balance<A> {
    assert!(lock.position.is_some(), errors::nothing_to_claim());
    let beneficiary = lock.beneficiary;
    let position = option::borrow_mut(&mut lock.position);
    let (_amt_a, _amt_b, bal_a, mut bal_b) = bluefin::collect_fee(clock, bf_config, bf_pool, position);
    let (creator_amt, platform_amt, pit_amt) = split_std_lp_quote(
        bal_b.value(),
        config.std_creator_bps(),
        config.std_platform_bps(),
        config.std_pit_bps(),
    );
    config::take_platform(config, bal_b.split(platform_amt));
    pit::take_fee(pit, bal_b.split(pit_amt));
    events::emit_collect_lp_fees(
        object::id(lock),
        beneficiary,
        bal_a.value(),
        creator_amt,
        platform_amt,
        pit_amt,
    );
    send_residual(bal_b, beneficiary, ctx);
    bal_a
}

/// Disabled. Same signature as v5 for Compatible upgrades. Use `launch::collect_instadex_fees`.
public fun collect_lp_fees<A, B>(
    _lock: &mut BluefinPositionLock,
    _clock: &Clock,
    _bf_config: &GlobalConfig,
    _bf_pool: &mut bluefin_spot::pool::Pool<A, B>,
    _config: &mut Config,
    _pit: &mut Pit<B>,
    _ctx: &mut TxContext,
) {
    abort_instadex_collect()
}

/// Body of the disabled `collect_lp_fees`. Extracted so unit tests can
/// hit abort 24 without constructing Bluefin `GlobalConfig` / `Pool`.
public(package) fun abort_instadex_collect() {
    abort errors::use_instadex_collect()
}

/// Disabled. Same signature as v4 for Compatible upgrades. Use `launch::collect_instadex_fees`.
public fun collect_bluefin_fees<A, B>(
    _lock: &mut BluefinPositionLock,
    _clock: &Clock,
    _bf_config: &GlobalConfig,
    _bf_pool: &mut bluefin_spot::pool::Pool<A, B>,
    _ctx: &mut TxContext,
) {
    abort_legacy_collect()
}

/// Body of the disabled `collect_bluefin_fees`. Extracted so unit tests can
/// hit abort 23 without constructing Bluefin `GlobalConfig` / `Pool`.
public(package) fun abort_legacy_collect() {
    abort errors::use_split_collect()
}

fun metadata_url<C>(meta: &CoinMetadata<C>): vector<u8> {
    let icon = meta.get_icon_url();
    if (icon.is_some()) {
        url::inner_url(&icon.destroy_some()).into_bytes()
    } else {
        icon.destroy_none();
        vector[]
    }
}

fun send_residual<C>(bal: Balance<C>, to: address, ctx: &mut TxContext) {
    if (bal.value() == 0) {
        bal.destroy_zero();
    } else {
        transfer::public_transfer(coin::from_balance(bal, ctx), to);
    }
}

fun send_residual_coin<C>(c: Coin<C>, to: address) {
    if (c.value() == 0) {
        c.destroy_zero();
    } else {
        transfer::public_transfer(c, to);
    }
}

public fun pool_id<T, Q>(lock: &LpLock<T, Q>): ID { lock.pool_id }
public fun beneficiary<T, Q>(lock: &LpLock<T, Q>): address { lock.beneficiary }
public fun unlock_ms<T, Q>(lock: &LpLock<T, Q>): u64 { lock.unlock_ms }
public fun token_value<T, Q>(lock: &LpLock<T, Q>): u64 { lock.token.value() }
public fun quote_value<T, Q>(lock: &LpLock<T, Q>): u64 { lock.quote.value() }

public fun bluefin_lock_pool_id(lock: &BluefinPositionLock): ID { lock.pool_id }
public fun bluefin_lock_spot_id(lock: &BluefinPositionLock): ID { lock.bluefin_pool_id }
public fun bluefin_lock_beneficiary(lock: &BluefinPositionLock): address { lock.beneficiary }
public fun bluefin_lock_unlock_ms(lock: &BluefinPositionLock): u64 { lock.unlock_ms }
public fun bluefin_lock_has_position(lock: &BluefinPositionLock): bool { lock.position.is_some() }

#[test_only]
public fun share_bluefin_lock_for_testing(
    pool_id: ID,
    bluefin_pool_id: ID,
    beneficiary: address,
    unlock_ms: u64,
    ctx: &mut TxContext,
) {
    transfer::share_object(BluefinPositionLock {
        id: object::new(ctx),
        pool_id,
        bluefin_pool_id,
        position: option::none(),
        beneficiary,
        unlock_ms,
    });
}
