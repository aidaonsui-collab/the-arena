#[test_only]
module arena::lock_lp_split_tests;

use arena::config::{Self, Config};
use arena::lock::{Self, BluefinPositionLock};
use sui::test_scenario::{Self as ts};

const ADMIN: address = @0xAD;
const STRANGER: address = @0xBAD;

fun share_plain_lock(beneficiary: address, ctx: &mut TxContext) {
    lock::share_bluefin_lock_for_testing(
        sui::object::id_from_address(@0x0),
        sui::object::id_from_address(@0xBF),
        beneficiary,
        0,
        ctx,
    );
}

#[test]
fun test_init_lock_lp_split_once() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        let config = scenario.take_shared<Config>();
        assert!(!lock::has_lp_split(&lock), 0);
        lock::init_lock_lp_split(&mut lock, 7000, 500, 1500, 1000, scenario.ctx());
        assert!(lock::has_lp_split(&lock), 1);
        let (c, p, pit, bb) = lock::lp_split(&lock, &config);
        assert!(c == 7000, 2);
        assert!(p == 500, 3);
        assert!(pit == 1500, 4);
        assert!(bb == 1000, 5);
        ts::return_shared(lock);
        ts::return_shared(config);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = 21)]
fun test_init_lock_lp_split_twice_aborts() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        lock::init_lock_lp_split(&mut lock, 6000, 500, 2500, 1000, scenario.ctx());
        lock::init_lock_lp_split(&mut lock, 5000, 500, 3500, 1000, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = 22)]
fun test_init_lock_lp_split_not_beneficiary() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(STRANGER);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        lock::init_lock_lp_split(&mut lock, 6000, 500, 2500, 1000, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = 2)]
fun test_new_lp_split_platform_floor() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        lock::init_lock_lp_split(&mut lock, 7000, 400, 1600, 1000, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}

#[test, expected_failure(abort_code = 2)]
fun test_new_lp_split_bad_sum() {
    let mut scenario = ts::begin(ADMIN);
    share_plain_lock(ADMIN, scenario.ctx());
    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<BluefinPositionLock>();
        lock::init_lock_lp_split(&mut lock, 6000, 500, 2500, 500, scenario.ctx());
        ts::return_shared(lock);
    };
    scenario.end();
}
