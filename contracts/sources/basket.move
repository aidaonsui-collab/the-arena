/// Fixed-recipe basket share vault. Not `arena::basket_yield`.
///
/// One shared object holds component `Balance`s and the share `TreasuryCap`.
/// Mint and redeem are the only uses of that cap. There is no withdraw, pause,
/// or recipe edit. The creator seed is minted into the vault and `redeem`
/// refuses to take supply below `seed_shares`.
module arena::basket;

use std::type_name::{Self, TypeName};
use sui::balance::{Self, Balance};
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
const E_SEED_FLOOR: u64 = 10;
const E_IS_SEED: u64 = 11;
const E_OVERFLOW: u64 = 12;
const E_PREMINTED: u64 = 13;
const E_NOT_SEEDED: u64 = 14;
const E_NOT_SEED: u64 = 15;

const MIN_LEGS: u64 = 2;
const MAX_LEGS: u64 = 8;
const U64_MAX: u128 = 18446744073709551615;

public struct BasketLeg has store, copy, drop {
    asset: TypeName,
    units_per_share: u64,
}

public struct BasketVault<phantom BASKET> has key {
    id: UID,
    treasury: TreasuryCap<BASKET>,
    recipe: vector<BasketLeg>,
    total_shares: u64,
    seed_shares: u64,
    deposit_cap: u64,
    /// Share coins that back the floor. Not redeemable.
    seed: Balance<BASKET>,
    creator: address,
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

public fun new_leg(asset: TypeName, units_per_share: u64): BasketLeg {
    BasketLeg { asset, units_per_share }
}

public fun create<BASKET>(
    treasury: TreasuryCap<BASKET>,
    recipe: vector<BasketLeg>,
    seed_shares: u64,
    deposit_cap: u64,
    ctx: &mut TxContext,
): (BasketVault<BASKET>, MintReceipt<BASKET>) {
    assert!(coin::total_supply(&treasury) == 0, E_PREMINTED);
    assert!(seed_shares > 0, E_ZERO_AMOUNT);
    assert!(deposit_cap >= seed_shares, E_CAP);
    validate_recipe(&recipe);
    let n = recipe.length();
    let mut deposited = vector[];
    let mut i = 0;
    while (i < n) {
        deposited.push_back(false);
        i = i + 1;
    };
    let id = object::new(ctx);
    let vault_id = object::uid_to_inner(&id);
    let vault = BasketVault<BASKET> {
        id,
        treasury,
        recipe,
        total_shares: 0,
        seed_shares,
        deposit_cap,
        seed: balance::zero<BASKET>(),
        creator: ctx.sender(),
    };
    let receipt = MintReceipt<BASKET> {
        vault_id,
        shares: seed_shares,
        deposited,
        seed: true,
    };
    (vault, receipt)
}

/// Pull the exact leg amount. Surplus comes back to the caller.
public fun deposit<BASKET, T>(
    vault: &mut BasketVault<BASKET>,
    receipt: &mut MintReceipt<BASKET>,
    mut payment: Coin<T>,
    ctx: &mut TxContext,
): Coin<T> {
    assert!(object::id(vault) == receipt.vault_id, E_WRONG_VAULT);
    let idx = leg_index<T>(&vault.recipe);
    assert!(!*vector::borrow(&receipt.deposited, idx), E_LEG_DONE);
    let need = mul(vault.recipe[idx].units_per_share, receipt.shares);
    assert!(payment.value() >= need, E_SHORT);
    let pay = payment.split(need, ctx);
    join_component<BASKET, T>(vault, pay.into_balance());
    *vector::borrow_mut(&mut receipt.deposited, idx) = true;
    payment
}

public fun finish_seed<BASKET>(
    mut vault: BasketVault<BASKET>,
    receipt: MintReceipt<BASKET>,
) {
    assert!(receipt.seed, E_NOT_SEED);
    consume_mint_receipt(&vault, receipt);
    let seed_shares = vault.seed_shares;
    let minted = coin::mint_balance(&mut vault.treasury, seed_shares);
    vault.seed.join(minted);
    vault.total_shares = vault.seed_shares;
    event::emit(BasketCreatedEvent {
        vault_id: object::id(&vault),
        basket_type: type_name::with_defining_ids<BASKET>(),
        creator: vault.creator,
        seed_shares: vault.seed_shares,
        deposit_cap: vault.deposit_cap,
    });
    transfer::share_object(vault);
}

public fun start_mint<BASKET>(
    vault: &BasketVault<BASKET>,
    shares: u64,
): MintReceipt<BASKET> {
    assert!(vault.total_shares >= vault.seed_shares && vault.seed_shares > 0, E_NOT_SEEDED);
    assert!(shares > 0, E_ZERO_AMOUNT);
    let next = add_u64(vault.total_shares, shares);
    assert!(next <= vault.deposit_cap, E_CAP);
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
    ctx: &mut TxContext,
): RedeemReceipt<BASKET> {
    let n = shares.value();
    assert!(n > 0, E_ZERO_AMOUNT);
    assert!(vault.total_shares - n >= vault.seed_shares, E_SEED_FLOOR);
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
    let tn = type_name::with_defining_ids<T>();
    let bal = df::borrow_mut<TypeName, Balance<T>>(&mut vault.id, tn);
    let out = mul_div_floor(bal.value(), receipt.shares, receipt.supply_before);
    let piece = bal.split(out);
    *vector::borrow_mut(&mut receipt.withdrawn, idx) = true;
    coin::from_balance(piece, ctx)
}

public fun finish_redeem<BASKET>(vault: &BasketVault<BASKET>, receipt: RedeemReceipt<BASKET>) {
    assert!(object::id(vault) == receipt.vault_id, E_WRONG_VAULT);
    assert!(all_set(&receipt.withdrawn), E_LEG_OPEN);
    let RedeemReceipt<BASKET> { vault_id: _, shares: _, supply_before: _, withdrawn: _ } = receipt;
}

public fun total_shares<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.total_shares }

public fun seed_shares<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.seed_shares }

public fun deposit_cap<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.deposit_cap }

public fun seed_balance<BASKET>(vault: &BasketVault<BASKET>): u64 { vault.seed.value() }

public fun component_value<BASKET, T>(vault: &BasketVault<BASKET>): u64 {
    let tn = type_name::with_defining_ids<T>();
    if (!df::exists_with_type<TypeName, Balance<T>>(&vault.id, tn)) {
        return 0
    };
    df::borrow<TypeName, Balance<T>>(&vault.id, tn).value()
}

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

/// Floor division. Dust stays in the vault.
fun mul_div_floor(bal: u64, shares: u64, supply: u64): u64 {
    assert!(supply > 0, E_ZERO_AMOUNT);
    let r = (bal as u128) * (shares as u128) / (supply as u128);
    r as u64
}

#[test_only]
public fun donate_for_testing<BASKET, T>(vault: &mut BasketVault<BASKET>, coin: Coin<T>) {
    join_component<BASKET, T>(vault, coin.into_balance());
}
