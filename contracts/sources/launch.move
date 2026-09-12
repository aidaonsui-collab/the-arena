/// Two-step curve launch, plus Instadex (direct Bluefin seed, no curve).
///
/// Curve: the creator publishes Coin<T> (TreasuryCap + metadata), then calls
/// `launch` to mint curve supply into a shared Pool<T, Q> and pay the SUI fee.
///
/// Instadex: same published Coin<T>. Create uses `launch_instant` (Robinpad Instant):
/// 100% of Coin<T>, 0 real quote, price from Config.instant_virtual_quote. `launch_instadex`
/// remains the two-sided seed. Both vault the Position NFT forever (`unlock_ms = 0`) and
/// lock TreasuryCap so nobody can mint after.
module arena::launch;

use arena::config::Config;
use arena::errors;
use arena::events;
use arena::basket_yield::{Self, BasketConfig, BasketYieldVault};
use arena::holder_yield::{Self, HolderYieldVault};
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

/// Robinpad Instant: 100% token, 0 real quote. Price from Config.instant_virtual_quote.
/// Creator pays the 1 SUI launch fee only. LP NFT locked forever.
public fun launch_instant<T, Q>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    ctx: &mut TxContext,
): ID {
    config.take_launch_fee(fee_sui);
    let token_amount = token.value();
    assert!(token_amount > 0, errors::zero_amount());
    let virtual_quote = config.instant_virtual_quote<Q>();
    let fee = lock::take_creation_fee(bf_config, creation_fee, ctx.sender(), ctx);
    let (lock_id, bf_pool_id, position_id, _) = lock::seed_and_lock_instant(
        ctx.sender(),
        clock,
        bf_config,
        meta_t,
        meta_q,
        fee,
        token.into_balance(),
        virtual_quote,
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
        0,
        0,
        meta_t.get_name(),
        meta_t.get_symbol(),
    );
    events::emit_instadex_mint_lock(lock_id, mint_id);
    lock_id
}


/// Instant RWA holder-yield launch. Same as `launch_instant`, plus a shared
/// `HolderYieldVault<T, Q>` and a launch-locked DF on the lock. The pit-bps
/// quote slice from collect becomes claimable holder rewards (not pit pot).
/// Returns the lock id (same as Instant); also emits `HolderYieldLaunchEvent`.
public fun launch_instant_holder_yield<T, Q>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    ctx: &mut TxContext,
): ID {
    config.take_launch_fee(fee_sui);
    let token_amount = token.value();
    assert!(token_amount > 0, errors::zero_amount());
    let virtual_quote = config.instant_virtual_quote<Q>();
    let fee = lock::take_creation_fee(bf_config, creation_fee, ctx.sender(), ctx);
    let (lock_id, bf_pool_id, position_id, _, yield_id) = lock::seed_and_lock_instant_holder_yield(
        ctx.sender(),
        clock,
        bf_config,
        meta_t,
        meta_q,
        fee,
        token.into_balance(),
        virtual_quote,
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
        0,
        0,
        meta_t.get_name(),
        meta_t.get_symbol(),
    );
    events::emit_instadex_mint_lock(lock_id, mint_id);
    events::emit_holder_yield_launch(
        lock_id,
        yield_id,
        bf_pool_id,
        type_name::with_defining_ids<T>(),
        type_name::with_defining_ids<Q>(),
    );
    lock_id
}

public entry fun launch_instant_holder_yield_entry<T, Q>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    ctx: &mut TxContext,
) {
    launch_instant_holder_yield<T, Q>(
        config,
        clock,
        bf_config,
        treasury_cap,
        meta_t,
        meta_q,
        token,
        fee_sui,
        creation_fee,
        ctx,
    );
}


/// Instant RWA basket-yield launch. Same as `launch_instant`, plus a shared
/// `BasketYieldVault<T, Q>` and launch-locked `BasketYieldKey` DF. Pit-bps
/// quote slice stages into the vault (not pit). Mutually exclusive with holder-yield.
public fun launch_instant_basket_yield<T, Q>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    basket: BasketConfig,
    ctx: &mut TxContext,
): ID {
    config.take_launch_fee(fee_sui);
    let token_amount = token.value();
    assert!(token_amount > 0, errors::zero_amount());
    let virtual_quote = config.instant_virtual_quote<Q>();
    let fee = lock::take_creation_fee(bf_config, creation_fee, ctx.sender(), ctx);
    let payout_mode = basket_yield::config_payout_mode(&basket);
    let asset_count = basket_yield::config_asset_count(&basket);
    let (lock_id, bf_pool_id, position_id, _, basket_id) = lock::seed_and_lock_instant_basket_yield(
        ctx.sender(),
        clock,
        bf_config,
        meta_t,
        meta_q,
        fee,
        token.into_balance(),
        virtual_quote,
        basket,
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
        0,
        0,
        meta_t.get_name(),
        meta_t.get_symbol(),
    );
    events::emit_instadex_mint_lock(lock_id, mint_id);
    events::emit_basket_yield_launch(
        lock_id,
        basket_id,
        bf_pool_id,
        type_name::with_defining_ids<T>(),
        type_name::with_defining_ids<Q>(),
        payout_mode,
        asset_count,
    );
    lock_id
}

/// Entry: 1-asset basket (pad Create).
public entry fun launch_instant_basket_yield_entry<T, Q, A0>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    weight0: u64,
    equal_weight: bool,
    payout_mode: u8,
    ctx: &mut TxContext,
) {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A0>(), weight0));
    let basket = basket_yield::new_config(assets, equal_weight, payout_mode);
    launch_instant_basket_yield<T, Q>(
        config, clock, bf_config, treasury_cap, meta_t, meta_q, token, fee_sui, creation_fee, basket, ctx,
    );
}

/// Entry: 2-asset basket.
public entry fun launch_instant_basket_yield_2_entry<T, Q, A0, A1>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    weight0: u64,
    weight1: u64,
    equal_weight: bool,
    payout_mode: u8,
    ctx: &mut TxContext,
) {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A0>(), weight0));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A1>(), weight1));
    let basket = basket_yield::new_config(assets, equal_weight, payout_mode);
    launch_instant_basket_yield<T, Q>(
        config, clock, bf_config, treasury_cap, meta_t, meta_q, token, fee_sui, creation_fee, basket, ctx,
    );
}

/// Entry: 3-asset basket (XAUM / XAGM / USDY).
public entry fun launch_instant_basket_yield_3_entry<T, Q, A0, A1, A2>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    weight0: u64,
    weight1: u64,
    weight2: u64,
    equal_weight: bool,
    payout_mode: u8,
    ctx: &mut TxContext,
) {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A0>(), weight0));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A1>(), weight1));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A2>(), weight2));
    let basket = basket_yield::new_config(assets, equal_weight, payout_mode);
    launch_instant_basket_yield<T, Q>(
        config, clock, bf_config, treasury_cap, meta_t, meta_q, token, fee_sui, creation_fee, basket, ctx,
    );
}


/// Forward-only migrate: plain Instant `BluefinPositionLock` (no yield DF) →
/// holder-yield. Auth: `lock.beneficiary` only. Creates a vault bound to the
/// existing `lock_id` + `bluefin_pool_id` (no Bluefin reseed / no new lock),
/// attaches `HolderYieldKey`, emits `HolderYieldLaunchEvent`. Does not touch Pit.
/// Intended when Instant is already quoted in RWA (XAUM / XAGM / USDY).
public fun migrate_instant_to_holder_yield<T, Q>(
    lock: &mut BluefinPositionLock,
    ctx: &mut TxContext,
): ID {
    assert!(
        ctx.sender() == lock::bluefin_lock_beneficiary(lock),
        errors::not_beneficiary(),
    );
    // Fail before creating an orphan vault if already yield-mode.
    assert!(!lock::is_holder_yield(lock), errors::already_locked());
    assert!(!lock::is_basket_yield(lock), errors::yield_mode_conflict());
    let lock_id = object::id(lock);
    let bf_pool_id = lock::bluefin_lock_spot_id(lock);
    let yield_id = holder_yield::create_vault_for_lock<T, Q>(lock_id, bf_pool_id, ctx);
    lock::attach_holder_yield(lock, yield_id);
    events::emit_holder_yield_launch(
        lock_id,
        yield_id,
        bf_pool_id,
        type_name::with_defining_ids<T>(),
        type_name::with_defining_ids<Q>(),
    );
    yield_id
}

public entry fun migrate_instant_to_holder_yield_entry<T, Q>(
    lock: &mut BluefinPositionLock,
    ctx: &mut TxContext,
) {
    migrate_instant_to_holder_yield<T, Q>(lock, ctx);
}

/// Forward-only migrate: plain Instant → basket-yield. Auth: beneficiary.
/// Caller supplies `BasketConfig` (1–3 assets, bps sum 10000, payout mode).
/// No Bluefin reseed; Pit untouched. Prefer when Instant is quoted in SUI
/// (or non-basket Q).
public fun migrate_instant_to_basket_yield<T, Q>(
    lock: &mut BluefinPositionLock,
    basket: BasketConfig,
    ctx: &mut TxContext,
): ID {
    assert!(
        ctx.sender() == lock::bluefin_lock_beneficiary(lock),
        errors::not_beneficiary(),
    );
    assert!(!lock::is_basket_yield(lock), errors::already_locked());
    assert!(!lock::is_holder_yield(lock), errors::yield_mode_conflict());
    let payout_mode = basket_yield::config_payout_mode(&basket);
    let asset_count = basket_yield::config_asset_count(&basket);
    let lock_id = object::id(lock);
    let bf_pool_id = lock::bluefin_lock_spot_id(lock);
    let basket_id = basket_yield::create_vault_for_lock<T, Q>(
        lock_id,
        bf_pool_id,
        basket,
        ctx,
    );
    lock::attach_basket_yield(lock, basket_id);
    events::emit_basket_yield_launch(
        lock_id,
        basket_id,
        bf_pool_id,
        type_name::with_defining_ids<T>(),
        type_name::with_defining_ids<Q>(),
        payout_mode,
        asset_count,
    );
    basket_id
}

/// Entry: 1-asset basket migrate (mirrors `launch_instant_basket_yield_entry`).
public entry fun migrate_instant_to_basket_yield_entry<T, Q, A0>(
    lock: &mut BluefinPositionLock,
    weight0: u64,
    equal_weight: bool,
    payout_mode: u8,
    ctx: &mut TxContext,
) {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A0>(), weight0));
    let basket = basket_yield::new_config(assets, equal_weight, payout_mode);
    migrate_instant_to_basket_yield<T, Q>(lock, basket, ctx);
}

/// Entry: 2-asset basket migrate.
public entry fun migrate_instant_to_basket_yield_2_entry<T, Q, A0, A1>(
    lock: &mut BluefinPositionLock,
    weight0: u64,
    weight1: u64,
    equal_weight: bool,
    payout_mode: u8,
    ctx: &mut TxContext,
) {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A0>(), weight0));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A1>(), weight1));
    let basket = basket_yield::new_config(assets, equal_weight, payout_mode);
    migrate_instant_to_basket_yield<T, Q>(lock, basket, ctx);
}

/// Entry: 3-asset basket migrate (XAUM / XAGM / USDY).
public entry fun migrate_instant_to_basket_yield_3_entry<T, Q, A0, A1, A2>(
    lock: &mut BluefinPositionLock,
    weight0: u64,
    weight1: u64,
    weight2: u64,
    equal_weight: bool,
    payout_mode: u8,
    ctx: &mut TxContext,
) {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A0>(), weight0));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A1>(), weight1));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<A2>(), weight2));
    let basket = basket_yield::new_config(assets, equal_weight, payout_mode);
    migrate_instant_to_basket_yield<T, Q>(lock, basket, ctx);
}

public entry fun launch_instant_entry<T, Q>(
    config: &mut Config,
    clock: &Clock,
    bf_config: &mut GlobalConfig,
    treasury_cap: TreasuryCap<T>,
    meta_t: &CoinMetadata<T>,
    meta_q: &CoinMetadata<Q>,
    token: Coin<T>,
    fee_sui: Coin<SUI>,
    creation_fee: Coin<SUI>,
    ctx: &mut TxContext,
) {
    launch_instant<T, Q>(
        config,
        clock,
        bf_config,
        treasury_cap,
        meta_t,
        meta_q,
        token,
        fee_sui,
        creation_fee,
        ctx,
    );
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

/// Permissionless collect for holder-yield Instant locks. Quote pit-bps →
/// `HolderYieldVault` (claimable); token A still burned via mint lock.
/// Aborts if the lock is not in holder-yield mode — use `collect_instadex_fees`.
public fun collect_instadex_fees_holder_yield<A, B>(
    lock: &mut BluefinPositionLock,
    mint: &mut InstadexMintLock<A>,
    vault: &mut HolderYieldVault<A, B>,
    clock: &Clock,
    bf_config: &GlobalConfig,
    bf_pool: &mut bluefin_spot::pool::Pool<A, B>,
    config: &mut Config,
    ctx: &mut TxContext,
) {
    let bal_a = lock::collect_lp_fees_return_token_to_holders(
        lock,
        vault,
        clock,
        bf_config,
        bf_pool,
        config,
        ctx,
    );
    let amount = bal_a.value();
    if (amount == 0) {
        bal_a.destroy_zero();
    } else {
        coin::burn(&mut mint.cap, coin::from_balance(bal_a, ctx));
    };
    events::emit_instadex_burn(object::id(lock), amount);
}



/// Permissionless collect for basket-yield Instant locks. Quote pit-bps →
/// `BasketYieldVault` staging; token A still burned via mint lock.
/// Aborts if the lock is not in basket-yield mode.
public fun collect_instadex_fees_basket_yield<A, B>(
    lock: &mut BluefinPositionLock,
    mint: &mut InstadexMintLock<A>,
    vault: &mut BasketYieldVault<A, B>,
    clock: &Clock,
    bf_config: &GlobalConfig,
    bf_pool: &mut bluefin_spot::pool::Pool<A, B>,
    config: &mut Config,
    ctx: &mut TxContext,
) {
    let bal_a = lock::collect_lp_fees_return_token_to_basket(
        lock,
        vault,
        clock,
        bf_config,
        bf_pool,
        config,
        ctx,
    );
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
/// Permissionless: anyone holding `Coin<T>` can destroy it.
public fun burn_from_mint_lock<T>(mint: &mut InstadexMintLock<T>, c: Coin<T>) {
    let mint_id = object::id(mint);
    burn_pit_buy(mint, mint_id, c)
}

/// Pit buy-and-burn. `lock_id` is the BluefinPositionLock id so the existing
/// InstadexBurnEvent indexer attributes the burn to the bout.
public fun burn_pit_buy<T>(mint: &mut InstadexMintLock<T>, lock_id: ID, c: Coin<T>) {
    let amount = c.value();
    if (amount == 0) {
        c.destroy_zero();
        return
    };
    coin::burn(&mut mint.cap, c);
    events::emit_instadex_burn(lock_id, amount);
}
