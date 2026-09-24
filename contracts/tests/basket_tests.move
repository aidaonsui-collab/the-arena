#[test_only]
module arena::basket_tests;

use arena::basket::{Self, BasketVault};
use arena::bcoin::{Self, BCOIN};
use arena::config::{Self, Config};
use arena::tcoin::TCOIN;
use arena::tcoin2::TCOIN2;
use std::type_name;
use sui::coin::{Self, Coin};
use sui::sui::SUI;
use sui::test_scenario::{Self as ts};
use sui::transfer;

const ADMIN: address = @0xAD;
const USER: address = @0xA1;

fun recipe_sui_tcoin(): vector<basket::BasketLeg> {
    let mut legs = vector[];
    legs.push_back(basket::new_leg(type_name::with_defining_ids<SUI>(), 2));
    legs.push_back(basket::new_leg(type_name::with_defining_ids<TCOIN>(), 5));
    legs
}

fun pay<T>(amount: u64, ctx: &mut TxContext): Coin<T> {
    coin::mint_for_testing<T>(amount, ctx)
}

fun seal(vault: &mut BasketVault<BCOIN>, receipt: &mut basket::MintReceipt<BCOIN>, ctx: &mut TxContext) {
    let shares = basket::receipt_shares(receipt);
    let rest_s = basket::deposit(vault, receipt, pay<SUI>(2 * shares, ctx), ctx);
    let rest_t = basket::deposit(vault, receipt, pay<TCOIN>(5 * shares, ctx), ctx);
    coin::burn_for_testing(rest_s);
    coin::burn_for_testing(rest_t);
}

#[test]
fun test_seed_mint_redeem_round_trip() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 100, 1_000, scenario.ctx());
    seal(&mut vault, &mut receipt, scenario.ctx());
    basket::finish_seed(vault, receipt);

    scenario.next_tx(USER);
    {
        let mut vault = scenario.take_shared<BasketVault<BCOIN>>();
        assert!(basket::total_shares(&vault) == 100, 0);
        assert!(basket::seed_balance(&vault) == 100, 1);
        assert!(basket::component_value<BCOIN, SUI>(&vault) == 200, 2);
        assert!(basket::component_value<BCOIN, TCOIN>(&vault) == 500, 3);

        let mut receipt = basket::start_mint(&vault, 50);
        let rest_s = basket::deposit(&mut vault, &mut receipt, pay<SUI>(107, scenario.ctx()), scenario.ctx());
        let rest_t = basket::deposit(&mut vault, &mut receipt, pay<TCOIN>(250, scenario.ctx()), scenario.ctx());
        assert!(rest_s.value() == 7, 4);
        assert!(rest_t.value() == 0, 5);
        coin::burn_for_testing(rest_s);
        coin::burn_for_testing(rest_t);
        let shares = basket::finish_mint(&mut vault, receipt, scenario.ctx());
        assert!(shares.value() == 50, 6);
        assert!(basket::total_shares(&vault) == 150, 7);

        let mut redeem = basket::start_redeem(&mut vault, shares, scenario.ctx());
        let sui_out = basket::withdraw<BCOIN, SUI>(&mut vault, &mut redeem, scenario.ctx());
        let t_out = basket::withdraw<BCOIN, TCOIN>(&mut vault, &mut redeem, scenario.ctx());
        basket::finish_redeem(&vault, redeem);
        assert!(sui_out.value() == 100, 8);
        assert!(t_out.value() == 250, 9);
        assert!(basket::total_shares(&vault) == 100, 10);
        assert!(basket::component_value<BCOIN, SUI>(&vault) == 200, 11);
        assert!(basket::component_value<BCOIN, TCOIN>(&vault) == 500, 12);
        assert!(basket::seed_balance(&vault) == 100, 13);
        coin::burn_for_testing(sui_out);
        coin::burn_for_testing(t_out);
        ts::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun test_redeem_leaves_donation_dust() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 2, 10, scenario.ctx());
    seal(&mut vault, &mut receipt, scenario.ctx());
    basket::finish_seed(vault, receipt);

    scenario.next_tx(USER);
    {
        let mut vault = scenario.take_shared<BasketVault<BCOIN>>();
        basket::donate_for_testing(&mut vault, pay<SUI>(1, scenario.ctx()));
        let mut receipt = basket::start_mint(&vault, 1);
        seal(&mut vault, &mut receipt, scenario.ctx());
        let shares = basket::finish_mint(&mut vault, receipt, scenario.ctx());
        // SUI balance is 2*2 + 1 donation + 2 minted = 7. Redeem 1 of 3 shares floors to 2.
        let mut redeem = basket::start_redeem(&mut vault, shares, scenario.ctx());
        let sui_out = basket::withdraw<BCOIN, SUI>(&mut vault, &mut redeem, scenario.ctx());
        let t_out = basket::withdraw<BCOIN, TCOIN>(&mut vault, &mut redeem, scenario.ctx());
        basket::finish_redeem(&vault, redeem);
        assert!(sui_out.value() == 2, 0);
        assert!(basket::component_value<BCOIN, SUI>(&vault) == 5, 1);
        coin::burn_for_testing(sui_out);
        coin::burn_for_testing(t_out);
        ts::return_shared(vault);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 10)]
fun test_cannot_redeem_through_seed_floor() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 100, 1_000, scenario.ctx());
    seal(&mut vault, &mut receipt, scenario.ctx());
    basket::finish_seed(vault, receipt);

    scenario.next_tx(USER);
    {
        let mut vault = scenario.take_shared<BasketVault<BCOIN>>();
        let fake = coin::mint_for_testing<BCOIN>(1, scenario.ctx());
        let redeem = basket::start_redeem(&mut vault, fake, scenario.ctx());
        basket::destroy_redeem_for_testing(redeem);
        ts::return_shared(vault);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 9)]
fun test_deposit_short_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 100, scenario.ctx());
    let rest = basket::deposit(&mut vault, &mut receipt, pay<SUI>(19, scenario.ctx()), scenario.ctx());
    coin::burn_for_testing(rest);
    basket::destroy_receipt_for_testing(receipt);
    basket::share_for_testing(vault);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 6)]
fun test_deposit_wrong_type_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 100, scenario.ctx());
    let rest = basket::deposit(&mut vault, &mut receipt, pay<TCOIN2>(50, scenario.ctx()), scenario.ctx());
    coin::burn_for_testing(rest);
    basket::destroy_receipt_for_testing(receipt);
    basket::share_for_testing(vault);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 7)]
fun test_double_deposit_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 100, scenario.ctx());
    let rest = basket::deposit(&mut vault, &mut receipt, pay<SUI>(20, scenario.ctx()), scenario.ctx());
    coin::burn_for_testing(rest);
    let rest2 = basket::deposit(&mut vault, &mut receipt, pay<SUI>(20, scenario.ctx()), scenario.ctx());
    coin::burn_for_testing(rest2);
    basket::destroy_receipt_for_testing(receipt);
    basket::share_for_testing(vault);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 8)]
fun test_finish_mint_open_leg_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 100, scenario.ctx());
    seal(&mut vault, &mut receipt, scenario.ctx());
    basket::finish_seed(vault, receipt);

    scenario.next_tx(USER);
    {
        let mut vault = scenario.take_shared<BasketVault<BCOIN>>();
        let mut receipt = basket::start_mint(&vault, 1);
        let rest = basket::deposit(&mut vault, &mut receipt, pay<SUI>(2, scenario.ctx()), scenario.ctx());
        coin::burn_for_testing(rest);
        let shares = basket::finish_mint(&mut vault, receipt, scenario.ctx());
        coin::burn_for_testing(shares);
        ts::return_shared(vault);
    };
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 4)]
fun test_deposit_cap_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 12, scenario.ctx());
    seal(&mut vault, &mut receipt, scenario.ctx());
    basket::finish_seed(vault, receipt);

    scenario.next_tx(USER);
    {
        let vault = scenario.take_shared<BasketVault<BCOIN>>();
        let receipt = basket::start_mint(&vault, 3);
        basket::destroy_receipt_for_testing(receipt);
        ts::return_shared(vault);
    };
    scenario.end();
}

#[test]
fun test_seed_with_quote_sets_instant_open() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    let mut config = scenario.take_shared<Config>();
    assert!(config.instant_virtual_quote<BCOIN>() == 10_000_000, 0);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 100, scenario.ctx());
    seal(&mut vault, &mut receipt, scenario.ctx());
    basket::finish_seed_with_quote(&mut config, vault, receipt, 4_500_000_000_000);
    assert!(config.instant_virtual_quote<BCOIN>() == 4_500_000_000_000, 1);
    ts::return_shared(config);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 48)]
fun test_seed_quote_cannot_be_set_twice() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    scenario.next_tx(ADMIN);
    let mut config = scenario.take_shared<Config>();
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let (mut vault, mut receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 100, scenario.ctx());
    seal(&mut vault, &mut receipt, scenario.ctx());
    basket::finish_seed_with_quote(&mut config, vault, receipt, 4_500_000_000_000);
    config::add_instant_virtual_quote_once<BCOIN>(&mut config, 1);
    ts::return_shared(config);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 13)]
fun test_preminted_treasury_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (mut cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let minted = coin::mint(&mut cap, 1, scenario.ctx());
    coin::burn_for_testing(minted);
    let (vault, receipt) = basket::create<BCOIN>(cap, recipe_sui_tcoin(), 10, 100, scenario.ctx());
    basket::destroy_receipt_for_testing(receipt);
    basket::share_for_testing(vault);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 2)]
fun test_one_leg_recipe_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let mut legs = vector[];
    legs.push_back(basket::new_leg(type_name::with_defining_ids<SUI>(), 1));
    let (vault, receipt) = basket::create<BCOIN>(cap, legs, 10, 100, scenario.ctx());
    basket::destroy_receipt_for_testing(receipt);
    basket::share_for_testing(vault);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 3)]
fun test_dup_leg_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, meta) = bcoin::treasury(scenario.ctx());
    transfer::public_freeze_object(meta);
    let mut legs = vector[];
    legs.push_back(basket::new_leg(type_name::with_defining_ids<SUI>(), 1));
    legs.push_back(basket::new_leg(type_name::with_defining_ids<SUI>(), 2));
    let (vault, receipt) = basket::create<BCOIN>(cap, legs, 10, 100, scenario.ctx());
    basket::destroy_receipt_for_testing(receipt);
    basket::share_for_testing(vault);
    scenario.end();
}
