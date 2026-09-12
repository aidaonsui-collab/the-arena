#[test_only]
module arena::basket_yield_tests;

use arena::basket_yield::{Self, BasketYieldVault};
use arena::tcoin::TCOIN;
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

#[test]
fun test_config_equal_weight_and_effective_bps() {
    let cfg = sample_equal_config();
    assert!(basket_yield::config_asset_count(&cfg) == 2, 0);
    assert!(basket_yield::config_equal_weight(&cfg), 1);
    assert!(basket_yield::effective_weight_bps(&cfg, 0) == 5_000, 2);
    assert!(basket_yield::effective_weight_bps(&cfg, 1) == 5_000, 3);
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
    // sum != 10_000
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
fun test_claim_all_retired() {
    let mut scenario = ts::begin(ADMIN);
    basket_yield::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0x1),
        sui::object::id_from_address(@0x2),
        sample_equal_config(),
        scenario.ctx(),
    );
    scenario.next_tx(USER1);
    {
        let mut vault = scenario.take_shared<BasketYieldVault<TCOIN, SUI>>();
        basket_yield::claim_all(&mut vault, scenario.ctx());
        ts::return_shared(vault);
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
