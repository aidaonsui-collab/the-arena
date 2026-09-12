#[test_only]
module arena::basket_yield_tests;

use arena::basket_yield::{Self, BasketYieldVault};
use arena::lock::{Self, BluefinPositionLock};
use arena::tcoin::TCOIN;
use arena::tcoin2::TCOIN2;
use std::type_name;
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts};

const ADMIN: address = @0xAD;
const USER1: address = @0xA1;

fun sample_equal_config(): basket_yield::BasketConfig {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<SUI>(), 0));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<TCOIN>(), 0));
    basket_yield::new_config(assets, true, basket_yield::payout_all_at_once())
}

fun sample_weighted_config(): basket_yield::BasketConfig {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<SUI>(), 2_500));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<TCOIN>(), 7_500));
    basket_yield::new_config(assets, false, basket_yield::payout_rotating())
}

fun sample_rotating_config(): basket_yield::BasketConfig {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<SUI>(), 5_000));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<TCOIN>(), 5_000));
    basket_yield::new_config(assets, false, basket_yield::payout_rotating())
}

#[test]
fun test_config_equal_weight_and_effective_bps() {
    let cfg = sample_equal_config();
    assert!(basket_yield::config_asset_count(&cfg) == 2, 0);
    assert!(basket_yield::config_equal_weight(&cfg), 1);
    assert!(basket_yield::effective_weight_bps(&cfg, 0) == 5_000, 2);
    assert!(basket_yield::effective_weight_bps(&cfg, 1) == 5_000, 3);
    assert!(basket_yield::quote_share_for_index(&cfg, 0, 100) == 50, 4);
}

#[test]
fun test_config_weighted_sum_10000() {
    let cfg = sample_weighted_config();
    assert!(basket_yield::config_payout_mode(&cfg) == basket_yield::payout_rotating(), 0);
    assert!(basket_yield::effective_weight_bps(&cfg, 0) == 2_500, 1);
    assert!(basket_yield::effective_weight_bps(&cfg, 1) == 7_500, 2);
}

#[test]
#[expected_failure(abort_code = 38)]
fun test_config_bad_weight_sum_aborts() {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<SUI>(), 1_000));
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<TCOIN>(), 1_000));
    let _ = basket_yield::new_config(assets, false, basket_yield::payout_all_at_once());
}

#[test]
#[expected_failure(abort_code = 37)]
fun test_config_empty_aborts() {
    let _ = basket_yield::new_config(vector[], true, basket_yield::payout_all_at_once());
}

#[test]
#[expected_failure(abort_code = 42)]
fun test_config_bad_mode_aborts() {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<SUI>(), 0));
    let _ = basket_yield::new_config(assets, true, 9);
}

#[test]
fun test_sync_fund_quote_staging() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1_000);
    let cfg = sample_equal_config();
    basket_yield::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0xB1),
        sui::object::id_from_address(@0xB2),
        cfg,
        scenario.ctx(),
    );
    clock.share_for_testing();

    scenario.next_tx(USER1);
    {
        let mut vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let c = coin::mint_for_testing<TCOIN>(100, scenario.ctx());
        basket_yield::sync_registration(&mut vault, &c, scenario.ctx());
        assert!(basket_yield::total_registered(&vault) == 100, 0);
        let leftover = basket_yield::fund_quote_for_testing(
            &mut vault,
            coin::mint_for_testing<SUI>(30, scenario.ctx()).into_balance(),
            &clock,
        );
        assert!(leftover.value() == 0, 1);
        leftover.destroy_zero();
        assert!(basket_yield::quote_staging_value(&vault) == 30, 2);
        assert!(basket_yield::pending_quote_normalized(&vault, USER1) == 30, 3);
        coin::burn_for_testing(c);
        ts::return_shared(vault);
        ts::return_shared(clock);
    };
    scenario.end();
}

#[test]
fun test_fund_no_holders_returns_fee() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1);
    basket_yield::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0x1),
        sui::object::id_from_address(@0x2),
        sample_equal_config(),
        scenario.ctx(),
    );
    clock.share_for_testing();
    scenario.next_tx(ADMIN);
    {
        let mut vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let leftover = basket_yield::fund_quote_for_testing(
            &mut vault,
            coin::mint_for_testing<SUI>(30, scenario.ctx()).into_balance(),
            &clock,
        );
        assert!(leftover.value() == 30, 0);
        assert!(basket_yield::quote_staging_value(&vault) == 0, 1);
        coin::burn_for_testing(coin::from_balance(leftover, scenario.ctx()));
        ts::return_shared(vault);
        ts::return_shared(clock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 29)]
fun test_convert_stub_retired() {
    let mut scenario = ts::begin(ADMIN);
    basket_yield::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0x1),
        sui::object::id_from_address(@0x2),
        sample_equal_config(),
        scenario.ctx(),
    );
    scenario.next_tx(ADMIN);
    {
        let mut vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        basket_yield::convert_stub(&mut vault);
        ts::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun test_convert_deposit_and_claim_all() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(2_000);
    basket_yield::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0xB1),
        sui::object::id_from_address(@0xB2),
        sample_equal_config(),
        scenario.ctx(),
    );
    clock.share_for_testing();

    scenario.next_tx(USER1);
    {
        let mut vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let c = coin::mint_for_testing<TCOIN>(100, scenario.ctx());
        basket_yield::sync_registration(&mut vault, &c, scenario.ctx());
        let leftover = basket_yield::fund_quote_for_testing(
            &mut vault,
            coin::mint_for_testing<SUI>(100, scenario.ctx()).into_balance(),
            &clock,
        );
        leftover.destroy_zero();

        // Keeper: take staging Q, deposit RWAs (SUI + TCOIN stand-ins) weight-proportional.
        let q = basket_yield::take_quote_for_convert(&mut vault, 100, scenario.ctx());
        assert!(q.value() == 100, 0);
        assert!(basket_yield::quote_staging_value(&vault) == 0, 1);
        coin::burn_for_testing(q);

        let rwa0 = coin::mint_for_testing<SUI>(40, scenario.ctx());
        basket_yield::deposit_converted_asset(&mut vault, rwa0, 50, &clock);
        let rwa1 = coin::mint_for_testing<TCOIN>(60, scenario.ctx());
        basket_yield::deposit_converted_asset(&mut vault, rwa1, 50, &clock);

        assert!(basket_yield::pending_asset<TCOIN, SUI, SUI>(&vault, USER1) == 40, 2);
        assert!(basket_yield::pending_asset<TCOIN, SUI, TCOIN>(&vault, USER1) == 60, 3);

        let c0 = basket_yield::claim_all<TCOIN, SUI, SUI>(&mut vault, scenario.ctx());
        assert!(c0.value() == 40, 4);
        coin::burn_for_testing(c0);
        let c1 = basket_yield::claim_all<TCOIN, SUI, TCOIN>(&mut vault, scenario.ctx());
        assert!(c1.value() == 60, 5);
        coin::burn_for_testing(c1);

        coin::burn_for_testing(c);
        ts::return_shared(vault);
        ts::return_shared(clock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 41)]
fun test_deposit_unknown_asset_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1);
    basket_yield::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0x1),
        sui::object::id_from_address(@0x2),
        sample_equal_config(), // SUI + TCOIN only
        scenario.ctx(),
    );
    clock.share_for_testing();
    scenario.next_tx(USER1);
    {
        let mut vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let c = coin::mint_for_testing<TCOIN>(10, scenario.ctx());
        basket_yield::sync_registration(&mut vault, &c, scenario.ctx());
        let leftover = basket_yield::fund_quote_for_testing(
            &mut vault,
            coin::mint_for_testing<SUI>(10, scenario.ctx()).into_balance(),
            &clock,
        );
        leftover.destroy_zero();
        coin::burn_for_testing(basket_yield::take_quote_for_convert(&mut vault, 10, scenario.ctx()));
        // TCOIN2 not in config
        basket_yield::deposit_converted_asset(
            &mut vault,
            coin::mint_for_testing<TCOIN2>(1, scenario.ctx()),
            10,
            &clock,
        );
        coin::burn_for_testing(c);
        ts::return_shared(vault);
        ts::return_shared(clock);
    };
    scenario.end();
}

#[test]
fun test_claim_rotating_and_advance() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(3_000);
    basket_yield::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0x1),
        sui::object::id_from_address(@0x2),
        sample_rotating_config(),
        scenario.ctx(),
    );
    clock.share_for_testing();
    scenario.next_tx(USER1);
    {
        let mut vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let c = coin::mint_for_testing<TCOIN>(100, scenario.ctx());
        basket_yield::sync_registration(&mut vault, &c, scenario.ctx());
        let leftover = basket_yield::fund_quote_for_testing(
            &mut vault,
            coin::mint_for_testing<SUI>(20, scenario.ctx()).into_balance(),
            &clock,
        );
        leftover.destroy_zero();
        coin::burn_for_testing(basket_yield::take_quote_for_convert(&mut vault, 20, scenario.ctx()));
        basket_yield::deposit_converted_asset(
            &mut vault,
            coin::mint_for_testing<SUI>(10, scenario.ctx()),
            10,
            &clock,
        );
        basket_yield::deposit_converted_asset(
            &mut vault,
            coin::mint_for_testing<TCOIN>(10, scenario.ctx()),
            10,
            &clock,
        );
        assert!(basket_yield::rotate_index(&vault) == 0, 0);
        let paid = basket_yield::claim_rotating<TCOIN, SUI, SUI>(&mut vault, &clock, scenario.ctx());
        assert!(paid.value() == 10, 1);
        coin::burn_for_testing(paid);
        assert!(basket_yield::rotate_index(&vault) == 1, 2);
        let paid2 = basket_yield::claim_rotating<TCOIN, SUI, TCOIN>(&mut vault, &clock, scenario.ctx());
        assert!(paid2.value() == 10, 3);
        coin::burn_for_testing(paid2);
        assert!(basket_yield::rotate_index(&vault) == 0, 4);
        coin::burn_for_testing(c);
        ts::return_shared(vault);
        ts::return_shared(clock);
    };
    scenario.end();
}

#[test]
fun test_basket_lock_df_helpers() {
    let mut scenario = ts::begin(ADMIN);
    let basket_id = sui::object::id_from_address(@0xBEEF);
    lock::share_bluefin_lock_with_basket_for_testing(
        sui::object::id_from_address(@0x1),
        sui::object::id_from_address(@0x2),
        ADMIN,
        0,
        basket_id,
        scenario.ctx(),
    );
    scenario.next_tx(ADMIN);
    {
        let bf_lock = scenario.take_shared<BluefinPositionLock>();
        assert!(lock::is_basket_yield(&bf_lock), 0);
        assert!(lock::basket_yield_id(&bf_lock) == basket_id, 1);
        assert!(!lock::is_holder_yield(&bf_lock), 2);
        ts::return_shared(bf_lock);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 43)]
fun test_basket_collect_gate_aborts() {
    lock::abort_basket_yield_collect();
}

#[test]
#[expected_failure(abort_code = 44)]
fun test_attach_basket_conflicts_with_holder() {
    let mut scenario = ts::begin(ADMIN);
    let yield_id = sui::object::id_from_address(@0x1111);
    lock::share_bluefin_lock_with_yield_for_testing(
        sui::object::id_from_address(@0x1),
        sui::object::id_from_address(@0x2),
        ADMIN,
        0,
        yield_id,
        scenario.ctx(),
    );
    scenario.next_tx(ADMIN);
    {
        let mut bf_lock = scenario.take_shared<BluefinPositionLock>();
        // test-only path: try attaching basket on holder lock via sharing helper can't;
        // use abort_basket isn't right. Call attach through a test-only wrapper.
        // Direct: share_bluefin_lock_with_basket would create new lock.
        // Instead exercise yield_mode_conflict by attaching basket id onto holder lock.
        lock::debug_attach_basket_for_testing(&mut bf_lock, sui::object::id_from_address(@0xBADD));
        ts::return_shared(bf_lock);
    };
    scenario.end();
}
