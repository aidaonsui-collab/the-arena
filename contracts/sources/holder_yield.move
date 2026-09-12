/// Instadex Instant RWA holder-yield (v1).
///
/// Launch-locked mode for Instant launches quoted in wrapped RWA (XAUM / XAGM /
/// USDY): the standard pit slice (`std_pit_bps`, default 30%) of collected LP
/// quote fees is parked as claimable `Coin<Q>` for registered holders instead of
/// funding the pit pot. Creator / platform cuts and token-side burns are unchanged.
///
/// Magnified-dividend accounting mirrors `pool::Holder` / `distribute_reflection`
/// / `claim_pit` (prefer claim over push airdrop). Registration is explicit:
/// holders call `sync_registration` with a `Coin<T>` (merge coins first for full
/// weight). External transfers do not update the registry — same caveat as the
/// curve pool registry.
///
/// Default Instant / curve pit launches stay on the pit path; only locks with the
/// `HolderYieldKey` DF (set at launch) use this vault.
module arena::holder_yield;

use arena::errors;
use arena::events;
use std::type_name;
use sui::balance::{Self, Balance};
use sui::clock::Clock;
use sui::coin::{Self, Coin};
use sui::object::{Self, ID, UID};
use sui::table::{Self, Table};
use sui::transfer;
use sui::tx_context::TxContext;

/// Magnified-dividend scalar (1e12). Same as `pool::MAG`.
const MAG: u256 = 1_000_000_000_000;

/// Per-address weight + unpaid claimable quote. Same shape as the pit half of
/// `pool::Holder` (single reward stream).
public struct YieldHolder has store, drop {
    amount: u64,
    debt: u256,
    unpaid: u64,
}

/// Shared claim vault bound 1:1 to an Instadex `BluefinPositionLock`.
public struct HolderYieldVault<phantom T, phantom Q> has key {
    id: UID,
    lock_id: ID,
    bluefin_pool_id: ID,
    holders: Table<address, YieldHolder>,
    total_registered: u64,
    reward_pot: Balance<Q>,
    mps: u256,
}

/// Create and share a vault for `lock_id` / Bluefin pool. Called once at Instant
/// holder-yield launch (before the lock is shared, DF points here).
public(package) fun create_and_share<T, Q>(
    lock_id: ID,
    bluefin_pool_id: ID,
    ctx: &mut TxContext,
): ID {
    let vault = HolderYieldVault<T, Q> {
        id: object::new(ctx),
        lock_id,
        bluefin_pool_id,
        holders: table::new(ctx),
        total_registered: 0,
        reward_pot: balance::zero<Q>(),
        mps: 0,
    };
    let id = object::id(&vault);
    transfer::share_object(vault);
    id
}

/// Alias for migrate / launch: vault bound to an existing Instant lock
/// (no Bluefin reseed). Same as `create_and_share`.
public(package) fun create_vault_for_lock<T, Q>(
    lock_id: ID,
    bluefin_pool_id: ID,
    ctx: &mut TxContext,
): ID {
    create_and_share<T, Q>(lock_id, bluefin_pool_id, ctx)
}

/// Route the pit-bps quote slice into claimable holder rewards.
/// Joins the pot when distribution succeeds. On failure (no holders / zero),
/// returns the balance for the caller to send to the creator residual — same
/// rescue pattern as `pool::distribute_reflection`.
public(package) fun try_fund<T, Q>(
    vault: &mut HolderYieldVault<T, Q>,
    fee: Balance<Q>,
    clock: &Clock,
): Balance<Q> {
    let amount = fee.value();
    if (amount == 0 || vault.total_registered == 0) {
        return fee
    };
    vault.mps = vault.mps + (amount as u256) * MAG / (vault.total_registered as u256);
    vault.reward_pot.join(fee);
    events::emit_holder_yield_funded(
        vault.lock_id,
        object::id(vault),
        vault.bluefin_pool_id,
        type_name::with_defining_ids<Q>(),
        amount,
        clock.timestamp_ms(),
    );
    balance::zero<Q>()
}

/// Set registry weight to `coin.value()`. Accrues unpaid before the update.
/// Merge wallet coins first if you want the full balance to count.
public fun sync_registration<T, Q>(
    vault: &mut HolderYieldVault<T, Q>,
    coin: &Coin<T>,
    ctx: &TxContext,
) {
    let who = ctx.sender();
    let new_amt = coin.value();
    let mps = vault.mps;
    ensure_holder(vault, who);
    let h = vault.holders.borrow_mut(who);
    accure(h, mps);
    let old = h.amount;
    if (new_amt >= old) {
        vault.total_registered = vault.total_registered + (new_amt - old);
    } else {
        vault.total_registered = vault.total_registered - (old - new_amt);
    };
    h.amount = new_amt;
    h.debt = (new_amt as u256) * mps;
}

/// Claim accrued quote rewards (pull model).
public fun claim<T, Q>(
    vault: &mut HolderYieldVault<T, Q>,
    ctx: &mut TxContext,
): Coin<Q> {
    let who = ctx.sender();
    assert!(vault.holders.contains(who), errors::nothing_to_claim());
    let mps = vault.mps;
    let h = vault.holders.borrow_mut(who);
    accure(h, mps);
    let amt = h.unpaid;
    h.unpaid = 0;
    assert!(amt > 0, errors::nothing_to_claim());
    events::emit_holder_yield_claim(
        vault.lock_id,
        object::id(vault),
        who,
        amt,
        type_name::with_defining_ids<Q>(),
    );
    coin::from_balance(vault.reward_pot.split(amt), ctx)
}

public fun assert_bound_to_lock<T, Q>(vault: &HolderYieldVault<T, Q>, lock_id: ID) {
    assert!(vault.lock_id == lock_id, errors::wrong_yield());
}

public fun lock_id<T, Q>(vault: &HolderYieldVault<T, Q>): ID { vault.lock_id }
public fun bluefin_pool_id<T, Q>(vault: &HolderYieldVault<T, Q>): ID { vault.bluefin_pool_id }
public fun total_registered<T, Q>(vault: &HolderYieldVault<T, Q>): u64 { vault.total_registered }
public fun reward_pot_value<T, Q>(vault: &HolderYieldVault<T, Q>): u64 { vault.reward_pot.value() }
public fun mps<T, Q>(vault: &HolderYieldVault<T, Q>): u256 { vault.mps }

public fun holder_amount<T, Q>(vault: &HolderYieldVault<T, Q>, who: address): u64 {
    if (!vault.holders.contains(who)) {
        0
    } else {
        vault.holders.borrow(who).amount
    }
}

public fun pending<T, Q>(vault: &HolderYieldVault<T, Q>, who: address): u64 {
    if (!vault.holders.contains(who)) {
        return 0
    };
    let h = vault.holders.borrow(who);
    let accum = (h.amount as u256) * vault.mps;
    let extra = if (accum > h.debt) {
        u256_to_u64((accum - h.debt) / MAG)
    } else {
        0
    };
    h.unpaid + extra
}

fun ensure_holder<T, Q>(vault: &mut HolderYieldVault<T, Q>, who: address) {
    if (!vault.holders.contains(who)) {
        vault.holders.add(who, YieldHolder { amount: 0, debt: 0, unpaid: 0 });
    }
}

fun accure(h: &mut YieldHolder, mps: u256) {
    let accum = (h.amount as u256) * mps;
    if (accum > h.debt) {
        h.unpaid = h.unpaid + u256_to_u64((accum - h.debt) / MAG);
    };
    h.debt = accum;
}

fun u256_to_u64(x: u256): u64 {
    assert!(x <= 18446744073709551615u256, errors::overflow());
    x as u64
}

#[test_only]
public fun create_for_testing<T, Q>(
    lock_id: ID,
    bluefin_pool_id: ID,
    ctx: &mut TxContext,
): ID {
    create_and_share<T, Q>(lock_id, bluefin_pool_id, ctx)
}

#[test_only]
/// Direct fund for unit tests (skips collect / Bluefin).
public fun fund_for_testing<T, Q>(
    vault: &mut HolderYieldVault<T, Q>,
    fee: Balance<Q>,
    clock: &Clock,
): Balance<Q> {
    try_fund(vault, fee, clock)
}
