/// Replacement for `arena::basket_yield`.
///
/// The old `take_quote_for_convert` is public and stays callable on every
/// vault already created, so this is a new type. Only `AdminCap` can take
/// staged quote out. `version` is checked on every state change so a later
/// upgrade can retire this bytecode.
module arena::yield_basket;

use arena::basket_yield::{Self, BasketConfig};
use arena::config::AdminCap;
use arena::errors;
use arena::events;
use std::type_name::{Self, TypeName};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::dynamic_field as df;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;

const VERSION: u64 = 1;

public struct AssetPotKey has copy, drop, store {
    asset: TypeName,
}

public struct AssetPot<phantom A> has store {
    bal: Balance<A>,
}

public struct PushDistributeKey has copy, drop, store {}

public struct YieldBasketVault<phantom T, phantom Q> has key {
    id: UID,
    version: u64,
    lock_id: ID,
    bluefin_pool_id: ID,
    config: BasketConfig,
    quote_staging: Balance<Q>,
}

fun check<T, Q>(vault: &YieldBasketVault<T, Q>) {
    assert!(vault.version == VERSION, errors::retired());
}

public(package) fun create_and_share<T, Q>(
    lock_id: ID,
    bluefin_pool_id: ID,
    config: BasketConfig,
    ctx: &mut TxContext,
): ID {
    basket_yield::validate_config(&config);
    let mut vault = YieldBasketVault<T, Q> {
        id: object::new(ctx),
        version: VERSION,
        lock_id,
        bluefin_pool_id,
        config,
        quote_staging: balance::zero<Q>(),
    };
    df::add(&mut vault.id, PushDistributeKey {}, true);
    let id = object::id(&vault);
    transfer::share_object(vault);
    id
}

public fun assert_bound_to_lock<T, Q>(vault: &YieldBasketVault<T, Q>, lock_id: ID) {
    check(vault);
    assert!(vault.lock_id == lock_id, errors::wrong_basket());
}

public fun lock_id<T, Q>(vault: &YieldBasketVault<T, Q>): ID { vault.lock_id }

public fun bluefin_pool_id<T, Q>(vault: &YieldBasketVault<T, Q>): ID { vault.bluefin_pool_id }

public fun quote_staging_value<T, Q>(vault: &YieldBasketVault<T, Q>): u64 {
    vault.quote_staging.value()
}

public fun vault_config<T, Q>(vault: &YieldBasketVault<T, Q>): &BasketConfig { &vault.config }

public(package) fun try_fund_quote<T, Q>(
    vault: &mut YieldBasketVault<T, Q>,
    fee: Balance<Q>,
    clock: &Clock,
): Balance<Q> {
    check(vault);
    let amount = fee.value();
    if (amount == 0) {
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

/// Staged quote leaves only with the keeper's AdminCap.
public fun take_quote_for_convert<T, Q>(
    vault: &mut YieldBasketVault<T, Q>,
    _: &AdminCap,
    amount: u64,
    ctx: &mut TxContext,
): Coin<Q> {
    check(vault);
    assert!(amount > 0, errors::zero_amount());
    assert!(amount <= vault.quote_staging.value(), errors::bad_param());
    coin::from_balance(vault.quote_staging.split(amount), ctx)
}

public fun deposit_converted_asset<T, Q, A>(
    vault: &mut YieldBasketVault<T, Q>,
    coin_a: Coin<A>,
    quote_spent: u64,
    clock: &Clock,
) {
    check(vault);
    let tn = type_name::with_defining_ids<A>();
    basket_yield::assert_asset_in_config(&vault.config, tn);
    let to_amount = coin_a.value();
    assert!(to_amount > 0, errors::zero_amount());
    let key = AssetPotKey { asset: tn };
    if (!df::exists_with_type<AssetPotKey, AssetPot<A>>(&vault.id, key)) {
        df::add(&mut vault.id, key, AssetPot<A> { bal: balance::zero<A>() });
    };
    {
        let pot: &mut AssetPot<A> = df::borrow_mut(&mut vault.id, key);
        pot.bal.join(coin_a.into_balance());
    };
    events::emit_basket_yield_converted(
        vault.lock_id,
        object::id(vault),
        type_name::with_defining_ids<Q>(),
        quote_spent,
        tn,
        to_amount,
        clock.timestamp_ms(),
    );
}

public fun push_payout<T, Q, A>(
    vault: &mut YieldBasketVault<T, Q>,
    _: &AdminCap,
    recipient: address,
    amount: u64,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    check(vault);
    assert!(amount > 0, errors::nothing_to_push());
    let tn = type_name::with_defining_ids<A>();
    basket_yield::assert_asset_in_config(&vault.config, tn);
    let key = AssetPotKey { asset: tn };
    assert!(df::exists_with_type<AssetPotKey, AssetPot<A>>(&vault.id, key), errors::nothing_to_push());
    let c = {
        let pot: &mut AssetPot<A> = df::borrow_mut(&mut vault.id, key);
        assert!(pot.bal.value() >= amount, errors::nothing_to_push());
        coin::from_balance(pot.bal.split(amount), ctx)
    };
    events::emit_basket_yield_push(
        vault.lock_id,
        object::id(vault),
        recipient,
        tn,
        amount,
        clock.timestamp_ms(),
    );
    transfer::public_transfer(c, recipient);
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
public fun fund_for_testing<T, Q>(
    vault: &mut YieldBasketVault<T, Q>,
    fee: Balance<Q>,
    clock: &Clock,
): Balance<Q> {
    try_fund_quote(vault, fee, clock)
}

#[test_only]
public fun set_version_for_testing<T, Q>(vault: &mut YieldBasketVault<T, Q>, version: u64) {
    vault.version = version;
}
