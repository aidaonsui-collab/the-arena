/// Fixed-recipe basket share vault. Not `arena::basket_yield`.
///
/// One share is a fixed amount of every asset. The creator receives the first
/// shares and can redeem them. Mint and redeem are the only uses of the
/// treasury. Holder backing cannot be withdrawn. Each asset pays a creator
/// fee, up to 1%, and a protocol fee of 0.35% on mint and 0.20% on redeem.
/// Protocol fees sit in their own bucket until anyone sweeps them to the
/// recipient stored on the vault.
module arena::basket;

use arena::config::{Self, Config};
use std::type_name::{Self, TypeName};
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin, TreasuryCap};
use sui::dynamic_field as df;
use sui::event;
use sui::object::{Self, ID, UID};
use sui::transfer;
use sui::tx_context::TxContext;

const E_ZERO_AMOUNT: u64 = 1;
const E_BAD_RECIPE: u64 = 2;
const E_DUP_LEG: u64 = 3;
const E_CAP: u64 = 4;
const E_WRONG_VAULT: u64 = 5;
const E_WRONG_TYPE: u64 = 6;
const E_LEG_DONE: u64 = 7;
const E_LEG_OPEN: u64 = 8;
const E_SHORT: u64 = 9;
const E_IS_SEED: u64 = 11;
const E_OVERFLOW: u64 = 12;
const E_PREMINTED: u64 = 13;
const E_NOT_SEEDED: u64 = 14;
const E_NOT_SEED: u64 = 15;
const E_FEE: u64 = 16;
const E_NOT_CREATOR: u64 = 18;
const E_THROTTLE: u64 = 19;
const E_EXCLUDED: u64 = 20;
const E_LIVE: u64 = 21;
const E_TOO_SOON: u64 = 22;

const MIN_LEGS: u64 = 2;
const MAX_LEGS: u64 = 8;
const U64_MAX: u128 = 18446744073709551615;
const PROTOCOL_MINT_BPS: u64 = 35;
const PROTOCOL_REDEEM_BPS: u64 = 20;
const MAX_OWNER_FEE_BPS: u64 = 100;
const HOUR_MS: u64 = 3_600_000;
const DAY_MS: u64 = 86_400_000;
const REDEEM_FLOOR_BPS: u64 = 1_000;

public struct BasketLeg has store, copy, drop {
    asset: TypeName,
    units_per_share: u64,
}

public struct OwnerFeeKey<phantom T> has copy, drop, store {}
public struct ProtocolFeeKey<phantom T> has copy, drop, store {}
public struct ForfeitedKey<phantom T> has copy, drop, store {}

public struct BasketVault<phantom BASKET> has key {
    id: UID,
    treasury: TreasuryCap<BASKET>,
    recipe: vector<BasketLeg>,
    total_shares: u64,
    seed_shares: u64,
    deposit_cap: u64,
    creator: address,
    seeded: bool,
    mint_fee_bps: u64,
    redeem_fee_bps: u64,
    protocol_recipient: address,
    issue_per_hour: u64,
    issue_left: u64,
    issue_at: u64,
    redeem_hour_bps: u64,
    redeem_left: u64,
    redeem_at: u64,
    excluded: vector<bool>,
    reported_at: vector<u64>,
}

/// Hot potato. Filled by `deposit`, consumed by `finish_seed` or `finish_mint`.
public struct MintReceipt<phantom BASKET> {
    vault_id: ID,
    shares: u64,
    deposited: vector<bool>,
    seed: bool,
}

/// Hot potato. One `withdraw` per recipe leg, then `finish_redeem`.
public struct RedeemReceipt<phantom BASKET> {
    vault_id: ID,
    shares: u64,
    supply_before: u64,
    withdrawn: vector<bool>,
}

public struct BasketCreatedEvent has copy, drop {
    vault_id: ID,
    basket_type: TypeName,
    creator: address,
    seed_shares: u64,
    deposit_cap: u64,
    mint_fee_bps: u64,
    redeem_fee_bps: u64,
}

public struct BasketMintEvent has copy, drop {
    vault_id: ID,
    shares: u64,
    minter: address,
}

public struct BasketRedeemEvent has copy, drop {
    vault_id: ID,
    shares: u64,
    redeemer: address,
}

public fun protocol_mint_bps(): u64 { PROTOCOL_MINT_BPS }
public fun protocol_redeem_bps(): u64 { PROTOCOL_REDEEM_BPS }
public fun max_owner_fee_bps(): u64 { MAX_OWNER_FEE_BPS }

public fun new_leg(asset: TypeName, units_per_share: u64): BasketLeg {
    BasketLeg { asset, units_per_share }
}

public fun create<BASKET>(
    treasury: TreasuryCap<BASKET>,
    recipe: vector<BasketLeg>,
    seed_shares: u64,
    deposit_cap: u64,
    mint_fee_bps: u64,
    redeem_fee_bps: u64,
    protocol_recipient: address,
    ctx: &mut TxContext,
): (BasketVault<BASKET>, MintReceipt<BASKET>) {
    assert!(coin::total_supply(&treasury) == 0, E_PREMINTED);
    assert!(seed_shares > 0, E_ZERO_AMOUNT);
    assert!(deposit_cap >= seed_shares, E_CAP);
    assert!(mint_fee_bps <= MAX_OWNER_FEE_BPS && redeem_fee_bps <= MAX_OWNER_FEE_BPS, E_FEE);
    assert!(protocol_recipient != @0x0, E_FEE);
    validate_recipe(&recipe);
    let n = recipe.length();
    let mut deposited = vector[];
    let mut excluded = vector[];
    let mut reported_at = vector[];
    let mut i = 0;
    while (i < n) {
        deposited.push_back(false);
        excluded.push_back(false);
        reported_at.push_back(0);
        i = i + 1;
    };
    let issue_per_hour = issue_cap(deposit_cap);
    let id = object::new(ctx);
    let vault_id = object::uid_to_inner(&id);
    let vault = BasketVault<BASKET> {
        id,
        treasury,
        recipe,
        total_shares: 0,
        seed_shares,
        deposit_cap,
        creator: ctx.sender(),
        seeded: false,
        mint_fee_bps,
        redeem_fee_bps,
        protocol_recipient,
        issue_per_hour,
        issue_left: issue_per_hour,
        issue_at: 0,
        redeem_hour_bps: 10_000,
        redeem_left: 0,
        redeem_at: 0,
        excluded,
        reported_at,
    };
    let receipt = MintReceipt<BASKET> {
        vault_id,
        shares: seed_shares,
        deposited,
        seed: true,
    };
    (vault, receipt)
}

/// Pull backing plus the creator and protocol mint fees. Surplus comes back.
public fun deposit<BASKET, T>(
    vault: &mut BasketVault<BASKET>,
    receipt: &mut MintReceipt<BASKET>,
    mut payment: Coin<T>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(object::id(vault) == receipt.vault_id, E_WRONG_VAULT);
    let idx = leg_index<T>(&vault.recipe);
    assert!(!*vector::borrow(&vault.excluded, idx), E_EXCLUDED);
    assert!(!*vector::borrow(&receipt.deposited, idx), E_LEG_DONE);
    let base = mul(vault.recipe[idx].units_per_share, receipt.shares);
    let owner = ceil_bps(base, vault.mint_fee_bps);
    let proto = ceil_bps(base, PROTOCOL_MINT_BPS);
    let need = add_u64(add_u64(base, owner), proto);
    assert!(payment.value() >= need, E_SHORT);
    let backing = payment.split(base, ctx);
    join_component<BASKET, T>(vault, backing.into_balance());
    if (owner > 0) {
        let fee = payment.split(owner, ctx);
        join_owner_fee<BASKET, T>(vault, fee.into_balance());
    };
    if (proto > 0) {
        let fee = payment.split(proto, ctx);
        join_protocol_fee<BASKET, T>(vault, fee.into_balance());
    };
    *vector::borrow_mut(&mut receipt.deposited, idx) = true;
    payment
}

public fun finish_seed<BASKET>(
    vault: BasketVault<BASKET>,
    receipt: MintReceipt<BASKET>,
    ctx: &mut TxContext,
) {
    let (vault, shares) = complete_seed(vault, receipt, ctx);
    transfer::public_transfer(shares, ctx.sender());
    transfer::share_object(vault);
}

/// Same seed as `finish_seed`, and writes the Instant open price for this share
/// coin once. Later launches read `config::instant_virtual_quote` instead of
/// the 0.01-unit fallback.
public fun finish_seed_with_quote<BASKET>(
    config: &mut Config,
    vault: BasketVault<BASKET>,
    receipt: MintReceipt<BASKET>,
    virtual_quote: u64,
    ctx: &mut TxContext,
) {
    let (vault, shares) = complete_seed(vault, receipt, ctx);
    config::add_instant_virtual_quote_once<BASKET>(config, virtual_quote);
    transfer::public_transfer(shares, ctx.sender());
    transfer::share_object(vault);
}

fun complete_seed<BASKET>(
    mut vault: BasketVault<BASKET>,
    receipt: MintReceipt<BASKET>,
    ctx: &mut TxContext,
): (BasketVault<BASKET>, Coin<BASKET>) {
    assert!(receipt.seed, E_NOT_SEED);
    consume_mint_receipt(&vault, receipt);
    let shares = vault.seed_shares;
    let minted = coin::mint(&mut vault.treasury, shares, ctx);
    vault.total_shares = shares;
    vault.seeded = true;
    event::emit(BasketCreatedEvent {
        vault_id: object::id(&vault),
        basket_type: type_name::with_defining_ids<BASKET>(),
        creator: vault.creator,
        seed_shares: vault.seed_shares,
        deposit_cap: vault.deposit_cap,
        mint_fee_bps: vault.mint_fee_bps,
        redeem_fee_bps: vault.redeem_fee_bps,
    });
    (vault, minted)
}

public fun start_mint<BASKET>(
    vault: &mut BasketVault<BASKET>,
    shares: u64,
    clock: &Clock,
): MintReceipt<BASKET> {
    assert!(vault.seeded, E_NOT_SEEDED);
    assert!(shares > 0, E_ZERO_AMOUNT);
    let next = add_u64(vault.total_shares, shares);
    assert!(next <= vault.deposit_cap, E_CAP);
    take_issue(vault, shares, clock.timestamp_ms());
    let n = vault.recipe.length();
    let mut deposited = vector[];
    let mut i = 0;
    while (i < n) {
        deposited.push_back(false);
        i = i + 1;
    };
    MintReceipt<BASKET> {
        vault_id: object::id(vault),
        shares,
        deposited,
        seed: false,
    }
}

public fun finish_mint<BASKET>(
    vault: &mut BasketVault<BASKET>,
    receipt: MintReceipt<BASKET>,
    ctx: &mut TxContext,
): Coin<BASKET> {
    assert!(!receipt.seed, E_IS_SEED);
    let shares = receipt.shares;
    consume_mint_receipt(vault, receipt);
    let next = add_u64(vault.total_shares, shares);
    assert!(next <= vault.deposit_cap, E_CAP);
    vault.total_shares = next;
    event::emit(BasketMintEvent {
        vault_id: object::id(vault),
        shares,
        minter: ctx.sender(),
    });
    coin::mint(&mut vault.treasury, shares, ctx)
}

public fun start_redeem<BASKET>(
    vault: &mut BasketVault<BASKET>,
    shares: Coin<BASKET>,
    clock: &Clock,
    ctx: &mut TxContext,
): RedeemReceipt<BASKET> {
    let n = shares.value();
    assert!(n > 0, E_ZERO_AMOUNT);
    assert!(n <= vault.total_shares, E_CAP);
    take_redeem(vault, n, clock.timestamp_ms());
    let supply_before = vault.total_shares;
    coin::burn(&mut vault.treasury, shares);
    vault.total_shares = vault.total_shares - n;
    let legs = vault.recipe.length();
    let mut withdrawn = vector[];
    let mut i = 0;
    while (i < legs) {
        withdrawn.push_back(false);
        i = i + 1;
    };
    event::emit(BasketRedeemEvent {
        vault_id: object::id(vault),
        shares: n,
        redeemer: ctx.sender(),
    });
    RedeemReceipt<BASKET> {
        vault_id: object::id(vault),
        shares: n,
        supply_before,
        withdrawn,
    }
}

public fun withdraw<BASKET, T>(
    vault: &mut BasketVault<BASKET>,
    receipt: &mut RedeemReceipt<BASKET>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(object::id(vault) == receipt.vault_id, E_WRONG_VAULT);
    let idx = leg_index<T>(&vault.recipe);
    assert!(!*vector::borrow(&receipt.withdrawn, idx), E_LEG_DONE);
    assert!(!*vector::borrow(&vault.excluded, idx), E_EXCLUDED);
    let tn = type_name::with_defining_ids<T>();
    let bal = df::borrow_mut<TypeName, Balance<T>>(&mut vault.id, tn);
    let gross = mul_div_floor(bal.value(), receipt.shares, receipt.supply_before);
    let owner = floor_bps(gross, vault.redeem_fee_bps);
    let proto = floor_bps(gross, PROTOCOL_REDEEM_BPS);
    let fees = add_u64(owner, proto);
    assert!(fees <= gross, E_OVERFLOW);
    let payout = gross - fees;
    let mut taken = bal.split(gross);
    let payout_bal = taken.split(payout);
    if (owner > 0) {
        let fee = taken.split(owner);
        join_owner_fee<BASKET, T>(vault, fee);
    };
    if (proto > 0) {
        let fee = taken.split(proto);
        join_protocol_fee<BASKET, T>(vault, fee);
    };
    balance::destroy_zero(taken);
    *vector::borrow_mut(&mut receipt.withdrawn, idx) = true;
    coin::from_balance(payout_bal, ctx)
}

/// Skip an excluded asset. Its gross backing moves to the forfeited bucket, with no fee.
public fun forfeit<BASKET, T>(
    vault: &mut BasketVault<BASKET>,
    receipt: &mut RedeemReceipt<BASKET>,
) {
    assert!(object::id(vault) == receipt.vault_id, E_WRONG_VAULT);
    let idx = leg_index<T>(&vault.recipe);
    assert!(!*vector::borrow(&receipt.withdrawn, idx), E_LEG_DONE);
    assert!(*vector::borrow(&vault.excluded, idx), E_LIVE);
    let tn = type_name::with_defining_ids<T>();
    let bal = df::borrow_mut<TypeName, Balance<T>>(&mut vault.id, tn);
    let gross = mul_div_floor(bal.value(), receipt.shares, receipt.supply_before);
    let taken = bal.split(gross);
    if (taken.value() > 0) join_forfeited<BASKET, T>(vault, taken)
    else balance::destroy_zero(taken);
    *vector::borrow_mut(&mut receipt.withdrawn, idx) = true;
}

public fun exclude<BASKET, T>(vault: &mut BasketVault<BASKET>, ctx: &mut TxContext) {
    assert!(ctx.sender() == vault.creator, E_NOT_CREATOR);
    let idx = leg_index<T>(&vault.recipe);
    *vector::borrow_mut(&mut vault.excluded, idx) = true;
}

public fun report_failure<BASKET, T>(vault: &mut BasketVault<BASKET>, clock: &Clock) {
    let idx = leg_index<T>(&vault.recipe);
    assert!(!*vector::borrow(&vault.excluded, idx), E_EXCLUDED);
    if (*vector::borrow(&vault.reported_at, idx) == 0) {
        let mut now = clock.timestamp_ms();
        if (now == 0) now = 1;
        *vector::borrow_mut(&mut vault.reported_at, idx) = now;
    };
}

public fun confirm_failure<BASKET, T>(vault: &mut BasketVault<BASKET>, clock: &Clock) {
    let idx = leg_index<T>(&vault.recipe);
    let at = *vector::borrow(&vault.reported_at, idx);
    assert!(at > 0, E_TOO_SOON);
    assert!(clock.timestamp_ms() >= at + DAY_MS, E_TOO_SOON);
    *vector::borrow_mut(&mut vault.excluded, idx) = true;
}

public fun restore<BASKET, T>(vault: &mut BasketVault<BASKET>) {
    let idx = leg_index<T>(&vault.recipe);
    *vector::borrow_mut(&mut vault.excluded, idx) = false;
    *vector::borrow_mut(&mut vault.reported_at, idx) = 0;
}

/// Recovered coins wait in the forfeited bucket until `accrete` returns them to holders.
public fun return_asset<BASKET, T>(vault: &mut BasketVault<BASKET>, coin: Coin<T>) {
    let _idx = leg_index<T>(&vault.recipe);
    join_forfeited<BASKET, T>(vault, coin.into_balance());
}

public fun finish_redeem<BASKET>(vault: &BasketVault<BASKET>, receipt: RedeemReceipt<BASKET>) {
    assert!(object::id(vault) == receipt.vault_id, E_WRONG_VAULT);
    assert!(all_set(&receipt.withdrawn), E_LEG_OPEN);
    let RedeemReceipt<BASKET> { vault_id: _, shares: _, supply_before: _, withdrawn: _ } = receipt;
}

/// Move forfeited value, or else the creator's fee, into holder backing.
public fun accrete<BASKET, T>(vault: &mut BasketVault<BASKET>) {
    let forfeited = ForfeitedKey<T> {};
    if (df::exists_with_type<ForfeitedKey<T>, Balance<T>>(&vault.id, forfeited)) {
        let bal = df::remove<ForfeitedKey<T>, Balance<T>>(&mut vault.id, forfeited);
        if (bal.value() > 0) {
            join_component<BASKET, T>(vault, bal);
            return
        };
        balance::destroy_zero(bal);
    };
    let key = OwnerFeeKey<T> {};
    assert!(df::exists_with_type<OwnerFeeKey<T>, Balance<T>>(&vault.id, key), E_ZERO_AMOUNT);
    let bal = df::remove<OwnerFeeKey<T>, Balance<T>>(&mut vault.id, key);
    assert!(bal.value() > 0, E_ZERO_AMOUNT);
    join_component<BASKET, T>(vault, bal);
}

public fun withdraw_owner_fees<BASKET, T>(
    vault: &mut BasketVault<BASKET>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(ctx.sender() == vault.creator, E_NOT_CREATOR);
    take_owner_fee<BASKET, T>(vault, ctx)
}

public fun sweep_protocol_fees<BASKET, T>(vault: &mut BasketVault<BASKET>, ctx: &mut TxContext) {
    let coin = take_protocol_fee<BASKET, T>(vault, ctx);
    transfer::public_transfer(coin, vault.protocol_recipient);
}

public fun total_shares<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.total_shares }

public fun seed_shares<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.seed_shares }

public fun deposit_cap<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.deposit_cap }

public fun mint_fee_bps<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.mint_fee_bps }

public fun redeem_fee_bps<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.redeem_fee_bps }

public fun protocol_recipient<BASKET>(vault: &BasketVault<BASKET>): address { vault.protocol_recipient }

public fun component_value<BASKET, T>(vault: &BasketVault<BASKET>): u64 {
    bucket_value<BASKET, TypeName, T>(vault, type_name::with_defining_ids<T>())
}

public fun owner_fee_value<BASKET, T>(vault: &BasketVault<BASKET>): u64 {
    bucket_value<BASKET, OwnerFeeKey<T>, T>(vault, OwnerFeeKey<T> {})
}

public fun protocol_fee_value<BASKET, T>(vault: &BasketVault<BASKET>): u64 {
    bucket_value<BASKET, ProtocolFeeKey<T>, T>(vault, ProtocolFeeKey<T> {})
}

public fun forfeited_value<BASKET, T>(vault: &BasketVault<BASKET>): u64 {
    bucket_value<BASKET, ForfeitedKey<T>, T>(vault, ForfeitedKey<T> {})
}

public fun is_excluded<BASKET, T>(vault: &BasketVault<BASKET>): bool {
    *vector::borrow(&vault.excluded, leg_index<T>(&vault.recipe))
}

public fun issue_per_hour<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.issue_per_hour }

public fun leg_count<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.recipe.length() }

public fun receipt_shares<BASKET>(receipt: &MintReceipt<BASKET>): u64 { receipt.shares }

#[test_only]
public fun destroy_receipt_for_testing<BASKET>(receipt: MintReceipt<BASKET>) {
    let MintReceipt<BASKET> { vault_id: _, shares: _, deposited: _, seed: _ } = receipt;
}

#[test_only]
public fun destroy_redeem_for_testing<BASKET>(receipt: RedeemReceipt<BASKET>) {
    let RedeemReceipt<BASKET> { vault_id: _, shares: _, supply_before: _, withdrawn: _ } = receipt;
}

#[test_only]
public fun share_for_testing<BASKET>(vault: BasketVault<BASKET>) {
    transfer::share_object(vault);
}

fun consume_mint_receipt<BASKET>(vault: &BasketVault<BASKET>, receipt: MintReceipt<BASKET>) {
    assert!(object::id(vault) == receipt.vault_id, E_WRONG_VAULT);
    assert!(all_set(&receipt.deposited), E_LEG_OPEN);
    let MintReceipt<BASKET> { vault_id: _, shares: _, deposited: _, seed: _ } = receipt;
}

fun join_component<BASKET, T>(vault: &mut BasketVault<BASKET>, piece: Balance<T>) {
    let tn = type_name::with_defining_ids<T>();
    if (!df::exists_with_type<TypeName, Balance<T>>(&vault.id, tn)) {
        df::add<TypeName, Balance<T>>(&mut vault.id, tn, balance::zero<T>());
    };
    df::borrow_mut<TypeName, Balance<T>>(&mut vault.id, tn).join(piece);
}

fun join_owner_fee<BASKET, T>(vault: &mut BasketVault<BASKET>, piece: Balance<T>) {
    let key = OwnerFeeKey<T> {};
    if (!df::exists_with_type<OwnerFeeKey<T>, Balance<T>>(&vault.id, key)) {
        df::add<OwnerFeeKey<T>, Balance<T>>(&mut vault.id, key, balance::zero<T>());
    };
    df::borrow_mut<OwnerFeeKey<T>, Balance<T>>(&mut vault.id, OwnerFeeKey<T> {}).join(piece);
}

fun join_forfeited<BASKET, T>(vault: &mut BasketVault<BASKET>, piece: Balance<T>) {
    let key = ForfeitedKey<T> {};
    if (!df::exists_with_type<ForfeitedKey<T>, Balance<T>>(&vault.id, key)) {
        df::add<ForfeitedKey<T>, Balance<T>>(&mut vault.id, key, balance::zero<T>());
    };
    df::borrow_mut<ForfeitedKey<T>, Balance<T>>(&mut vault.id, ForfeitedKey<T> {}).join(piece);
}

fun join_protocol_fee<BASKET, T>(vault: &mut BasketVault<BASKET>, piece: Balance<T>) {
    let key = ProtocolFeeKey<T> {};
    if (!df::exists_with_type<ProtocolFeeKey<T>, Balance<T>>(&vault.id, key)) {
        df::add<ProtocolFeeKey<T>, Balance<T>>(&mut vault.id, key, balance::zero<T>());
    };
    df::borrow_mut<ProtocolFeeKey<T>, Balance<T>>(&mut vault.id, ProtocolFeeKey<T> {}).join(piece);
}

fun take_owner_fee<BASKET, T>(vault: &mut BasketVault<BASKET>, ctx: &mut TxContext): Coin<T> {
    let key = OwnerFeeKey<T> {};
    assert!(df::exists_with_type<OwnerFeeKey<T>, Balance<T>>(&vault.id, key), E_ZERO_AMOUNT);
    let bal = df::remove<OwnerFeeKey<T>, Balance<T>>(&mut vault.id, key);
    assert!(bal.value() > 0, E_ZERO_AMOUNT);
    coin::from_balance(bal, ctx)
}

fun take_protocol_fee<BASKET, T>(vault: &mut BasketVault<BASKET>, ctx: &mut TxContext): Coin<T> {
    let key = ProtocolFeeKey<T> {};
    assert!(df::exists_with_type<ProtocolFeeKey<T>, Balance<T>>(&vault.id, key), E_ZERO_AMOUNT);
    let bal = df::remove<ProtocolFeeKey<T>, Balance<T>>(&mut vault.id, key);
    assert!(bal.value() > 0, E_ZERO_AMOUNT);
    coin::from_balance(bal, ctx)
}

fun bucket_value<BASKET, K: copy + drop + store, T>(vault: &BasketVault<BASKET>, key: K): u64 {
    if (!df::exists_with_type<K, Balance<T>>(&vault.id, key)) {
        return 0
    };
    df::borrow<K, Balance<T>>(&vault.id, key).value()
}

fun validate_recipe(recipe: &vector<BasketLeg>) {
    let n = recipe.length();
    assert!(n >= MIN_LEGS && n <= MAX_LEGS, E_BAD_RECIPE);
    let mut i = 0;
    while (i < n) {
        assert!(recipe[i].units_per_share > 0, E_BAD_RECIPE);
        let mut j = 0;
        while (j < i) {
            assert!(recipe[j].asset != recipe[i].asset, E_DUP_LEG);
            j = j + 1;
        };
        i = i + 1;
    };
}

fun leg_index<T>(recipe: &vector<BasketLeg>): u64 {
    let tn = type_name::with_defining_ids<T>();
    let n = recipe.length();
    let mut i = 0;
    while (i < n) {
        if (recipe[i].asset == tn) {
            return i
        };
        i = i + 1;
    };
    abort E_WRONG_TYPE
}

fun all_set(flags: &vector<bool>): bool {
    let n = flags.length();
    let mut i = 0;
    while (i < n) {
        if (!*vector::borrow(flags, i)) {
            return false
        };
        i = i + 1;
    };
    true
}

fun mul(a: u64, b: u64): u64 {
    let r = (a as u128) * (b as u128);
    assert!(r <= U64_MAX, E_OVERFLOW);
    r as u64
}

fun add_u64(a: u64, b: u64): u64 {
    let r = (a as u128) + (b as u128);
    assert!(r <= U64_MAX, E_OVERFLOW);
    r as u64
}

fun issue_cap(deposit_cap: u64): u64 {
    let v = deposit_cap / 10;
    if (v == 0) 1 else v
}

fun refill(left: u64, at: u64, now: u64, cap: u64): (u64, u64) {
    if (cap == 0) return (0, now);
    if (at == 0) return (cap, if (now == 0) 1 else now);
    if (now <= at) return (left, at);
    let elapsed = now - at;
    if (elapsed >= HOUR_MS) return (cap, now);
    let add = (((cap as u128) * (elapsed as u128)) / (HOUR_MS as u128)) as u64;
    let mut sum = add_u64(left, add);
    if (sum > cap) sum = cap;
    (sum, now)
}

fun take_issue<BASKET>(vault: &mut BasketVault<BASKET>, shares: u64, now: u64) {
    let cap = vault.issue_per_hour;
    let (left, at) = refill(vault.issue_left, vault.issue_at, now, cap);
    assert!(shares <= left, E_THROTTLE);
    vault.issue_left = left - shares;
    vault.issue_at = at;
}

fun redeem_allowance<BASKET>(vault: &BasketVault<BASKET>): u64 {
    let supply = vault.total_shares;
    if (supply == 0) return 1;
    let floor = mul_div_floor(supply, REDEEM_FLOOR_BPS, 10_000);
    let mut floor_shares = floor;
    if (floor_shares == 0) floor_shares = 1;
    let configured = mul_div_floor(supply, vault.redeem_hour_bps, 10_000);
    if (configured > floor_shares) configured else floor_shares
}

fun take_redeem<BASKET>(vault: &mut BasketVault<BASKET>, shares: u64, now: u64) {
    let cap = redeem_allowance(vault);
    let (left, at) = refill(vault.redeem_left, vault.redeem_at, now, cap);
    assert!(shares <= left, E_THROTTLE);
    vault.redeem_left = left - shares;
    vault.redeem_at = at;
}

fun ceil_bps(base: u64, bps: u64): u64 {
    if (bps == 0 || base == 0) return 0;
    let r = ((base as u128) * (bps as u128) + 9999) / 10000;
    assert!(r <= U64_MAX, E_OVERFLOW);
    r as u64
}

fun floor_bps(base: u64, bps: u64): u64 {
    if (bps == 0 || base == 0) return 0;
    let r = (base as u128) * (bps as u128) / 10000;
    r as u64
}

/// Floor division. Dust stays in the vault.
fun mul_div_floor(bal: u64, shares: u64, supply: u64): u64 {
    assert!(supply > 0, E_ZERO_AMOUNT);
    let r = (bal as u128) * (shares as u128) / (supply as u128);
    r as u64
}

#[test_only]
public fun set_redeem_hour_bps_for_testing<BASKET>(vault: &mut BasketVault<BASKET>, bps: u64) {
    vault.redeem_hour_bps = bps;
}

#[test_only]
public fun donate_for_testing<BASKET, T>(vault: &mut BasketVault<BASKET>, coin: Coin<T>) {
    join_component<BASKET, T>(vault, coin.into_balance());
}
