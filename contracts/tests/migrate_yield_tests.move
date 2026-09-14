#[test_only]
module arena::migrate_yield_tests;

use arena::basket_yield::{Self, BasketYieldVault};
use arena::config::{Self, AdminCap};
use arena::errors;
use arena::holder_yield::HolderYieldVault;
use arena::launch;
use arena::lock::{Self, BluefinPositionLock};
use arena::tcoin::TCOIN;
use arena::tcoin2::TCOIN2;
use std::type_name;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts};

const ADMIN: address = @0xAD;
const STRANGER: address = @0xBAD;

/// Calls in this file go through `..._for_testing`, not the real
/// `migrate_instant_to_*` entrypoints — those now require a live
/// `&bluefin_spot::pool::Pool<T, Q>` (the fix for the exact bug
/// `test_admin_detach_*` below recovers from), and bluefin-spot's vendored
/// interface package is stub-only (`abort 0` on every function, including
/// `create_pool`), so no `Pool<T, Q>` can be constructed inside `sui move
/// test` at all. See `migrate_instant_to_holder_yield_v2_for_testing`'s doc
/// comment in launch.move.

fun share_plain_lock(beneficiary: address, ctx: &mut TxContext) {
    lock::share_bluefin_lock_for_testing(
        sui::object::id_from_address(@0x0),
        sui::object::id_from_address(@0xBF),
        beneficiary,
        0,
        ctx,
    );
}

fun sample_equal_basket(): basket_yield::BasketConfig {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<SUI>(), 0));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<TCOIN>(), 0));
    basket_yield::new_config(assets, true, basket_yield::payout_all_at_once())
}

#[test]
fun test_migrate_instant_to_holder_yield_success() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        assert!(!lock::is_holder_yield(&lock), 0);
        assert!(!lock::is_basket_yield(&lock), 1);
        let yield_id = launch::migrate_instant_to_holder_yield_v2_for_testing<TCOIN, SUI>(&mut lock, scenario.ctx());
        assert!(lock::is_holder_yield(&lock), 2);
        assert!(lock::holder_yield_id(&lock) == yield_id, 3);
        assert!(!lock::is_basket_yield(&lock), 4);
        ts::return_shared(lock);
    };
    scenario.next_tx(ADMIN);
    {
        let vault = scenario.take_shared<HolderYieldVault<TCOIN, SUI>>();
        let lock = scenario.take_shared<BluefinPositionLock>();
        assert!(sui::object::id(&vault) == lock::holder_yield_id(&lock), 5);
        assert!(
            arena::holder_yield::lock_id(&vault) == sui::object::id(&lock),
            6,
        );
        assert!(
            arena::holder_yield::bluefin_pool_id(&vault) == lock::bluefin_lock_spot_id(&lock),
            7,
        );
        ts::return_shared(vault);
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test]
fun test_migrate_instant_to_basket_yield_success() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let basket_id = launch::migrate_instant_to_basket_yield_v2_for_testing<TCOIN, SUI>(
            &mut lock,
            sample_equal_basket(),
            scenario.ctx(),
        );
        assert!(lock::is_basket_yield(&lock), 0);
        assert!(lock::basket_yield_id(&lock) == basket_id, 1);
        assert!(!lock::is_holder_yield(&lock), 2);
        ts::return_shared(lock);
    };
    scenario.next_tx(ADMIN);
    {
        let vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        let lock = scenario.take_shared<BluefinPositionLock>();
        assert!(sui::object::id(&vault) == lock::basket_yield_id(&lock), 3);
        assert!(basket_yield::config_asset_count(basket_yield::vault_config(&vault)) == 2, 4);
        ts::return_shared(vault);
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 21)]
fun test_migrate_holder_aborts_if_already_holder_yield() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_holder_yield_v2_for_testing<TCOIN, SUI>(&mut lock, scenario.ctx());
        // second migrate → already_locked (21)
        let _ = launch::migrate_instant_to_holder_yield_v2_for_testing<TCOIN, SUI>(&mut lock, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 44)]
fun test_migrate_basket_aborts_if_already_holder_yield() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_holder_yield_v2_for_testing<TCOIN, SUI>(&mut lock, scenario.ctx());
        let _ = launch::migrate_instant_to_basket_yield_v2_for_testing<TCOIN, SUI>(
            &mut lock,
            sample_equal_basket(),
            scenario.ctx(),
        );
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 22)]
fun test_migrate_holder_aborts_if_not_beneficiary() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(STRANGER);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_holder_yield_v2_for_testing<TCOIN, SUI>(&mut lock, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 22)]
fun test_migrate_basket_aborts_if_not_beneficiary() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(STRANGER);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_basket_yield_v2_for_testing<TCOIN, SUI>(
            &mut lock,
            sample_equal_basket(),
            scenario.ctx(),
        );
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 38)]
fun test_migrate_basket_invalid_weights_aborts() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let mut assets = vector[];
        assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<SUI>(), 1_000));
        assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<TCOIN2>(), 1_000));
        // sum != 10000 → basket_bad_weights (38) inside new_config / create
        let bad = basket_yield::new_config(assets, false, basket_yield::payout_all_at_once());
        let _ = launch::migrate_instant_to_basket_yield_v2_for_testing<TCOIN, SUI>(&mut lock, bad, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}

// ── admin_detach_yield ────────────────────────────────────────────────────
// Recovery path for a lock stuck bound to a `HolderYieldVault<T, Q>` /
// `BasketYieldVault<T, Q>` whose `<T, Q>` don't actually match the lock's
// real coin types — the class of mistake the live-pool check on
// `migrate_instant_to_*` now prevents going forward, but the wrong-type
// scenario itself can't be reproduced here (that's exactly what the pool
// check needs a live Bluefin `Pool<T, Q>` to catch, and none can be
// constructed in this test harness — see the file-top comment). What's
// tested instead is the mechanism: detach genuinely un-sticks the lock,
// covering both yield modes and the "nothing attached" abort.

#[test]
fun test_admin_detach_holder_yield_reverts_lock_to_plain() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_holder_yield_v2_for_testing<TCOIN, SUI>(&mut lock, scenario.ctx());
        assert!(lock::is_holder_yield(&lock), 0);
        ts::return_shared(lock);
    };
    scenario.next_tx(config::platform_wallet());
    let cap = scenario.take_from_sender<AdminCap>();
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        lock::admin_detach_yield(&mut lock, &cap);
        assert!(!lock::is_holder_yield(&lock), 1);
        assert!(!lock::is_basket_yield(&lock), 2);
        // Genuinely un-stuck, not just flagged clear: a fresh migrate (this
        // time to basket-yield, proving it isn't ghosted into the old mode)
        // succeeds on the same lock.
        let basket_id = launch::migrate_instant_to_basket_yield_v2_for_testing<TCOIN, SUI>(
            &mut lock,
            sample_equal_basket(),
            scenario.ctx(),
        );
        assert!(lock::is_basket_yield(&lock), 3);
        assert!(lock::basket_yield_id(&lock) == basket_id, 4);
        ts::return_shared(lock);
    };
    ts::return_to_address(config::platform_wallet(), cap);
    scenario.end();
}

#[test]
fun test_admin_detach_basket_yield_reverts_lock_to_plain() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_basket_yield_v2_for_testing<TCOIN, SUI>(
            &mut lock,
            sample_equal_basket(),
            scenario.ctx(),
        );
        assert!(lock::is_basket_yield(&lock), 0);
        ts::return_shared(lock);
    };
    scenario.next_tx(config::platform_wallet());
    let cap = scenario.take_from_sender<AdminCap>();
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        lock::admin_detach_yield(&mut lock, &cap);
        assert!(!lock::is_basket_yield(&lock), 1);
        assert!(!lock::is_holder_yield(&lock), 2);
        let yield_id = launch::migrate_instant_to_holder_yield_v2_for_testing<TCOIN, SUI>(&mut lock, scenario.ctx());
        assert!(lock::is_holder_yield(&lock), 3);
        assert!(lock::holder_yield_id(&lock) == yield_id, 4);
        ts::return_shared(lock);
    };
    ts::return_to_address(config::platform_wallet(), cap);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 45)]
fun test_admin_detach_aborts_when_nothing_attached() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(config::platform_wallet());
    let cap = scenario.take_from_sender<AdminCap>();
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        // never migrated → no_yield_to_detach (45)
        lock::admin_detach_yield(&mut lock, &cap);
        ts::return_shared(lock);
    };
    ts::return_to_address(config::platform_wallet(), cap);
    scenario.end();
}

#[test]
/// `test_admin_detach_aborts_when_nothing_attached` pins the abort code to
/// the literal 45; this pins the same literal to the named helper, so the
/// two can't silently drift apart if errors.move's constants are reordered.
fun test_no_yield_to_detach_error_code_is_45() {
    assert!(errors::no_yield_to_detach() == 45, 0);
}

// ── retired originals stay retired ────────────────────────────────────────
// The Compatible-upgrade twins for the wrong-type-arg fix: same name, same
// original signature, body is now `abort errors::retired()`. Real logic
// moved to `_v2`. Pinned here so nobody "helpfully" re-wires these later.

#[test]
#[expected_failure(abort_code = 29)]
fun test_migrate_holder_yield_original_signature_retired() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_holder_yield<TCOIN, SUI>(&mut lock, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 29)]
fun test_migrate_basket_yield_original_signature_retired() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let _ = launch::migrate_instant_to_basket_yield<TCOIN, SUI>(
            &mut lock,
            sample_equal_basket(),
            scenario.ctx(),
        );
        ts::return_shared(lock);
    };
    scenario.end();
}
