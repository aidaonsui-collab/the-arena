#[test_only]
module arena::yield_basket_tests;

use arena::basket_yield;
use arena::config;
use arena::tcoin::TCOIN;
use arena::yield_basket::{Self, YieldBasketVault};
use std::type_name;
use sui::clock;
use sui::coin;
use sui::sui::SUI;
use sui::test_scenario::{Self as ts};

const ADMIN: address = @0xAD;

fun cfg(): basket_yield::BasketConfig {
    let mut assets = vector[];
    assets.push_back(basket_yield::new_asset(type_name::with_defining_ids<TCOIN>(), 0));
    basket_yield::new_config(assets, true, basket_yield::payout_all_at_once())
}

#[test]
fun test_only_admin_can_take_staged_quote() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    yield_basket::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0xC1),
        sui::object::id_from_address(@0xC2),
        cfg(),
        scenario.ctx(),
    );
    scenario.next_tx(config::platform_wallet());
    {
        let mut vault = scenario.take_shared<YieldBasketVault<TCOIN, SUI>>();
        let cap = scenario.take_from_sender<config::AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        let fee = coin::mint_for_testing<SUI>(4_000_000_000, scenario.ctx());
        let left = yield_basket::fund_for_testing(&mut vault, fee.into_balance(), &clock);
        left.destroy_zero();
        assert!(yield_basket::quote_staging_value(&vault) == 4_000_000_000, 0);
        let taken = yield_basket::take_quote_for_convert(&mut vault, &cap, 4_000_000_000, scenario.ctx());
        assert!(taken.value() == 4_000_000_000, 1);
        assert!(yield_basket::quote_staging_value(&vault) == 0, 2);
        coin::burn_for_testing(taken);
        clock::destroy_for_testing(clock);
        scenario.return_to_sender(cap);
        ts::return_shared(vault);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 29)]
fun test_retired_version_rejects_take() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    yield_basket::create_for_testing<TCOIN, SUI>(
        sui::object::id_from_address(@0xC1),
        sui::object::id_from_address(@0xC2),
        cfg(),
        scenario.ctx(),
    );
    scenario.next_tx(config::platform_wallet());
    {
        let mut vault = scenario.take_shared<YieldBasketVault<TCOIN, SUI>>();
        let cap = scenario.take_from_sender<config::AdminCap>();
        let clock = clock::create_for_testing(scenario.ctx());
        yield_basket::set_version_for_testing(&mut vault, 99);
        let fee = coin::mint_for_testing<SUI>(1, scenario.ctx());
        let left = yield_basket::fund_for_testing(&mut vault, fee.into_balance(), &clock);
        left.destroy_zero();
        let taken = yield_basket::take_quote_for_convert(&mut vault, &cap, 1, scenario.ctx());
        coin::burn_for_testing(taken);
        clock::destroy_for_testing(clock);
        scenario.return_to_sender(cap);
        ts::return_shared(vault);
    };
    scenario.end();
}
