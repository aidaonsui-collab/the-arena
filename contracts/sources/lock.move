/// SuiLock-style time vault for graduated bonding-curve reserves.
///
/// Stand-in until DeepBook seed; no hardcoded DeepBook IDs. After graduation,
/// anyone may move remaining `token_reserve` and `quote_reserve` into a shared
/// `LpLock<T, Q>`. The pool creator is the beneficiary and claims both coins
/// once `Clock` is at or past `unlock_ms` (`Config.lp_lock_ms`, default 180 days).
/// This module does not depend on VestSui and does not send SUI to a third-party admin.
module arena::lock;

use arena::config::Config;
use arena::errors;
use arena::events;
use arena::pool::{Self, Pool};
use sui::balance::Balance;
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;

public struct LpLock<phantom T, phantom Q> has key {
    id: UID,
    pool_id: ID,
    token: Balance<T>,
    quote: Balance<Q>,
    beneficiary: address,
    unlock_ms: u64,
}

/// Permissionless. Moves remaining curve balances into a shared vault. Once only.
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

public fun pool_id<T, Q>(lock: &LpLock<T, Q>): ID { lock.pool_id }
public fun beneficiary<T, Q>(lock: &LpLock<T, Q>): address { lock.beneficiary }
public fun unlock_ms<T, Q>(lock: &LpLock<T, Q>): u64 { lock.unlock_ms }
public fun token_value<T, Q>(lock: &LpLock<T, Q>): u64 { lock.token.value() }
public fun quote_value<T, Q>(lock: &LpLock<T, Q>): u64 { lock.quote.value() }
