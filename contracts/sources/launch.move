/// Two-step curve launch, plus Instadex (direct Bluefin seed, no curve).
///
/// Curve: the creator publishes Coin<T> (TreasuryCap + metadata), then calls
/// `launch` to mint curve supply into a shared Pool<T, Q> and pay the SUI fee.
///
/// Instadex: same published Coin<T>, but the creator brings both LP sides
/// (Coin<T> + Coin<Q>) and `launch_instadex` seeds a Bluefin Spot pool, vaults the Position NFT
/// forever (`unlock_ms = 0`), and permanently locks TreasuryCap so nobody can mint after.
module arena::launch;

use arena::config::Config;
use arena::errors;
use arena::events;
use arena::lock::{Self, BluefinPositionLock};
use arena::math;
use arena::pit::Pit;
use arena::pool;
use bluefin_spot::config::GlobalConfig;
use std::type_name;
use sui::clock::Clock;
use sui::coin::{Self, Coin, CoinMetadata, TreasuryCap};
use sui::object::{Self, ID, UID};
use sui::sui::SUI;
use sui::transfer;
use sui::tx_context::TxContext;

/// Shared vault that holds `TreasuryCap<T>` forever. No extract, no mint.
public struct InstadexMintLock<phantom T> has key {
    id: UID,
    cap: TreasuryCap<T>,
}

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

/// Direct Bluefin seed. No Pit, no curve Pool, no GraduationEvent.
/// TOKEN is Bluefin coin A, quote (SUI or XAUM) is coin B.
/// Returns the shared `BluefinPositionLock` id.
public fun launch_instadex<T, Q>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    quote: Coin<Q>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    ctx: &mut TxContext,
): ID {
    config.take_launch_fee(fee_sui);
    let token_amount = token.value();
    let quote_amount = quote.value();
    assert_instadex_amounts(token_amount, quote_amount);

    let fee = lock::take_creation_fee(bf_config, creation_fee, ctx.sender(), ctx);
    let sqrt_p = math::sqrt_price_x64(token_amount, quote_amount);
    let (lock_id, bf_pool_id, position_id, _) = lock::seed_and_lock_internal(
        object::id_from_address(@0x0),
        ctx.sender(),
        0,
        clock,
        bf_config,
        meta_t,
        meta_q,
        fee,
        token.into_balance(),
        quote.into_balance(),
        sqrt_p,
        ctx,
    );

    let mint = InstadexMintLock<T> {
        id: object::new(ctx),
        cap: treasury_cap,
    };
    let mint_id = object::id(&mint);
    transfer::share_object(mint);

    events::emit_instadex_launch(
        lock_id,
        bf_pool_id,
        position_id,
        type_name::with_defining_ids<T>(),
        type_name::with_defining_ids<Q>(),
        ctx.sender(),
        token_amount,
        quote_amount,
        0,
        meta_t.get_name(),
        meta_t.get_symbol(),
    );
    events::emit_instadex_mint_lock(lock_id, mint_id);
    lock_id
}

/// Entry wrapper: same as `launch_instadex`, discards the returned lock id.
public entry fun launch_instadex_entry<T, Q>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    quote: Coin<Q>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    ctx: &mut TxContext,
) {
    launch_instadex<T, Q>(
        config,
        clock,
        bf_config,
        treasury_cap,
        meta_t,
        meta_q,
        token,
        quote,
        fee_sui,
        creation_fee,
        ctx,
    );
}

/// Permissionless. Collect vaulted Instadex LP fees: burn token A via the
/// locked TreasuryCap, split quote B 60/10/30 creator/platform/pit.
/// NFT stays in the vault.
public fun collect_instadex_fees<A, B>(
    lock: &mut BluefinPositionLock,
    mint: &mut InstadexMintLock<A>,
    clock: &Clock,
    bf_config: &GlobalConfig,
    bf_pool: &mut bluefin_spot::pool::Pool<A, B>,
    config: &mut Config,
    pit: &mut Pit<B>,
    ctx: &mut TxContext,
) {
    let bal_a = lock::collect_lp_fees_return_token(lock, clock, bf_config, bf_pool, config, pit, ctx);
    let amount = bal_a.value();
    if (amount == 0) {
        bal_a.destroy_zero();
    } else {
        coin::burn(&mut mint.cap, coin::from_balance(bal_a, ctx));
    };
    events::emit_instadex_burn(object::id(lock), amount);
}

public(package) fun assert_instadex_amounts(token_amount: u64, quote_amount: u64) {
    assert!(token_amount > 0 && quote_amount > 0, errors::zero_amount());
}

#[test_only]
public fun share_mint_lock_for_testing<T>(cap: TreasuryCap<T>, ctx: &mut TxContext) {
    transfer::share_object(InstadexMintLock<T> {
        id: object::new(ctx),
        cap,
    });
}

#[test_only]
public fun mint_lock_supply<T>(mint: &InstadexMintLock<T>): u64 {
    coin::total_supply(&mint.cap)
}

/// Burn through the vaulted cap (same path collect_instadex_fees uses).
#[test_only]
public fun burn_from_mint_lock<T>(mint: &mut InstadexMintLock<T>, c: Coin<T>) {
    if (c.value() == 0) {
        c.destroy_zero();
    } else {
        coin::burn(&mut mint.cap, c);
    }
}
