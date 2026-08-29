/// Two-step launch: the creator publishes Coin<T> (TreasuryCap + metadata), then
/// calls `launch` to mint curve supply into a shared Pool<T, Q> and pay the SUI fee.
module arena::launch;

use arena::config::Config;
use arena::events;
use arena::pit::Pit;
use arena::pool;
use std::type_name;
use sui::clock::Clock;
use sui::coin::{Coin, CoinMetadata, TreasuryCap};
use sui::object::{Self, ID};
use sui::tx_context::TxContext;
use sui::sui::SUI;

public fun launch<T, Q>(
    config: &mut Config,
    pit: &Pit<Q>,
    treasury_cap: TreasuryCap<T>,
    metadata: &CoinMetadata<T>,
    fee_sui: Coin<SUI>,
    pit_mode: u8,
    reflection: bool,
    clock: &Clock,
    ctx: &mut TxContext,
): ID {
    let _pit_id = pit.id();
    config.take_launch_fee(fee_sui);
    let (virtual_quote, graduation_threshold) = config.quote_params<Q>();
    let virtual_token = config.virtual_token();
    let pool = pool::new<T, Q>(
        treasury_cap,
        metadata,
        virtual_quote,
        virtual_token,
        graduation_threshold,
        pit_mode,
        reflection,
        clock,
        ctx,
    );
    let pool_id = object::id(&pool);
    events::emit_launch(
        pool_id,
        type_name::with_defining_ids<T>(),
        type_name::with_defining_ids<Q>(),
        ctx.sender(),
        pit_mode,
        reflection,
        virtual_quote,
        virtual_token,
        metadata.get_name(),
        metadata.get_symbol(),
        );
    pool::share(pool);
    pool_id
}

/// Entry wrapper: same as `launch`, discards the returned ID.
public entry fun launch_entry<T, Q>(
    config: &mut Config,
    pit: &Pit<Q>,
    treasury_cap: TreasuryCap<T>,
    metadata: &CoinMetadata<T>,
    fee_sui: Coin<SUI>,
    pit_mode: u8,
    reflection: bool,
    clock: &Clock,
    ctx: &mut TxContext,
) {
    launch<T, Q>(config, pit, treasury_cap, metadata, fee_sui, pit_mode, reflection, clock, ctx);
}

public fun pit_holders(): u8 { pool::pit_holders() }
public fun pit_buy_and_burn(): u8 { pool::pit_buy_and_burn() }
