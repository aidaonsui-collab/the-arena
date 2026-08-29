#[test_only]
module arena::arena_tests;

use arena::config::{Self, Config};
use arena::qcoin::QCOIN;
use arena::launch;
use arena::pit::{Self, Pit};
use arena::pool::{Self, Pool};
use arena::tcoin::{Self, TCOIN};
use sui::clock::{Self, Clock};
use sui::coin;
use sui::sui::SUI;
use sui::transfer;
use sui::test_scenario::{Self as ts, Scenario};

const ADMIN: address = @0xAD;
const USER1: address = @0xA1;
const USER2: address = @0xA2;

fun setup(scenario: &mut Scenario) {
    config::init_for_testing(scenario.ctx());
    pit::create_pit<QCOIN>(scenario.ctx());
    scenario.next_tx(ADMIN);
    let mut config = scenario.take_shared<Config>();
    config.set_for_testing(
        1_000,
        100,
        200,
        50_000,
        50_000,
        10_000,
        10_000,
        1_000_000,
        1_000,
    );
    scenario.return_shared(config);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1);
    clock.share_for_testing();
}

fun launch_sui(scenario: &mut Scenario, sender: address, pit_mode: u8, reflection: bool) {
    scenario.next_tx(sender);
    let mut config = scenario.take_shared<Config>();
    let pit = scenario.take_shared<Pit<SUI>>();
    let clock = scenario.take_shared<Clock>();
    let (cap, metadata) = tcoin::create_for_testing(scenario.ctx());
    let fee = coin::mint_for_testing<SUI>(config.launch_fee_sui(), scenario.ctx());
    launch::launch<TCOIN, SUI>(
        &mut config,
        &pit,
        cap,
        &metadata,
        fee,
        pit_mode,
        reflection,
        &clock,
        scenario.ctx(),
    );
    transfer::public_freeze_object(metadata);
    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(clock);
}

fun launch_xaum(scenario: &mut Scenario, sender: address, pit_mode: u8, reflection: bool) {
    scenario.next_tx(sender);
    let mut config = scenario.take_shared<Config>();
    let pit = scenario.take_shared<Pit<QCOIN>>();
    let clock = scenario.take_shared<Clock>();
    let (cap, metadata) = tcoin::create_for_testing(scenario.ctx());
    let fee = coin::mint_for_testing<SUI>(config.launch_fee_sui(), scenario.ctx());
    launch::launch<TCOIN, QCOIN>(
        &mut config,
        &pit,
        cap,
        &metadata,
        fee,
        pit_mode,
        reflection,
        &clock,
        scenario.ctx(),
    );
    transfer::public_freeze_object(metadata);
    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(clock);
}

#[test]
fun test_launch_buy_sell_sui() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let clock = scenario.take_shared<Clock>();

    assert!(config.treasury_value() == 1_000, 0);
    assert!(pool.raised() == 0, 0);

    let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
    let mut tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
    // 1% pit on quote in; no reflection
    assert!(pool.raised() == 9_900, 1);
    assert!(pit.pot_value() == 100, 2);
    assert!(tokens.value() > 0, 3);

    let half = tokens.split(tokens.value() / 2, scenario.ctx());
    let quote_back = pool::sell(&mut pool, &config, &mut pit, half, 0, &clock, scenario.ctx());
    assert!(quote_back.value() > 0, 4);
    assert!(pit.pot_value() > 100, 5);
    // cumulative raised does not fall on sell
    assert!(pool.raised() == 9_900, 6);

    coin::burn_for_testing(tokens);
    coin::burn_for_testing(quote_back);
    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(pool);
    scenario.return_shared(clock);
    scenario.end();
}

#[test]
fun test_launch_buy_xaum() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_xaum(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<QCOIN>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, QCOIN>>();
    let clock = scenario.take_shared<Clock>();

    let pay = coin::mint_for_testing<QCOIN>(10_000, scenario.ctx());
    let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
    assert!(pool.raised() == 9_900, 0);
    assert!(pit.pot_value() == 100, 1);
    assert!(tokens.value() > 0, 2);

    coin::burn_for_testing(tokens);
    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(pool);
    scenario.return_shared(clock);
    scenario.end();
}

#[test]
fun test_reflection_two_buyers() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), true);

    scenario.next_tx(USER1);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
        transfer::public_transfer(tokens, USER1);
        scenario.return_shared(config);
        scenario.return_shared(pit);
        scenario.return_shared(pool);
        scenario.return_shared(clock);
    };

    scenario.next_tx(USER2);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
        let refl = pool::claim_reflection(&mut pool, scenario.ctx());
        assert!(refl.value() > 0, 0);
        coin::burn_for_testing(tokens);
        coin::burn_for_testing(refl);
        scenario.return_shared(config);
        scenario.return_shared(pit);
        scenario.return_shared(pool);
        scenario.return_shared(clock);
    };

    scenario.end();
}

#[test]
fun test_graduation() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let clock = scenario.take_shared<Clock>();

    let pay = coin::mint_for_testing<SUI>(60_000, scenario.ctx());
    let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
    assert!(pool.raised() >= 50_000, 0);
    assert!(pool.is_graduated(), 1);

    coin::burn_for_testing(tokens);
    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(pool);
    scenario.return_shared(clock);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 5)]
fun test_buy_after_graduation_aborts() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let clock = scenario.take_shared<Clock>();

    let pay = coin::mint_for_testing<SUI>(60_000, scenario.ctx());
    let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
    coin::burn_for_testing(tokens);
    assert!(pool.is_graduated(), 0);

    let pay2 = coin::mint_for_testing<SUI>(1_000, scenario.ctx());
    let tokens2 = pool::buy(&mut pool, &config, &mut pit, pay2, 0, &clock, scenario.ctx());
    coin::burn_for_testing(tokens2);

    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(pool);
    scenario.return_shared(clock);
    scenario.end();
}

#[test]
fun test_pit_holders_claim() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
        transfer::public_transfer(tokens, USER1);
        scenario.return_shared(config);
        scenario.return_shared(pit);
        scenario.return_shared(pool);
        scenario.return_shared(clock);
    };

    scenario.next_tx(USER2);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
        transfer::public_transfer(tokens, USER2);
        scenario.return_shared(config);
        scenario.return_shared(pit);
        scenario.return_shared(pool);
        scenario.return_shared(clock);
    };

    scenario.next_tx(ADMIN);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let mut clock = scenario.take_shared<Clock>();
        clock.set_for_testing(2_000);
        pit::ring(&mut pit, config.round_ms(), &clock);
        pool::settle_pit(&mut pool, &mut pit, scenario.ctx());
        assert!(pit.pot_value() == 0, 0);
        scenario.return_shared(config);
        scenario.return_shared(pit);
        scenario.return_shared(pool);
        scenario.return_shared(clock);
    };

    scenario.next_tx(USER1);
    {
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let c = pool::claim_pit(&mut pool, scenario.ctx());
        assert!(c.value() > 0, 1);
        coin::burn_for_testing(c);
        scenario.return_shared(pool);
    };

    scenario.next_tx(USER2);
    {
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let c = pool::claim_pit(&mut pool, scenario.ctx());
        assert!(c.value() > 0, 2);
        coin::burn_for_testing(c);
        scenario.return_shared(pool);
    };

    scenario.end();
}

#[test]
fun test_pit_buy_and_burn() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_buy_and_burn(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let mut clock = scenario.take_shared<Clock>();

    let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
    let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 0, &clock, scenario.ctx());
    let reserve_before = pool.token_reserves();
    let supply_before = pool.total_supply();
    assert!(pit.pot_value() == 100, 0);

    clock.set_for_testing(2_000);
    pit::ring(&mut pit, config.round_ms(), &clock);
    pool::settle_pit(&mut pool, &mut pit, scenario.ctx());

    assert!(pool.token_reserves() < reserve_before, 1);
    assert!(pool.total_supply() < supply_before, 2);
    assert!(pit.pot_value() == 0, 3);

    coin::burn_for_testing(tokens);
    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(pool);
    scenario.return_shared(clock);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 2)]
fun test_launch_fee_required() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    scenario.next_tx(ADMIN);
    let mut config = scenario.take_shared<Config>();
    let pit = scenario.take_shared<Pit<SUI>>();
    let clock = scenario.take_shared<Clock>();
    let (cap, metadata) = tcoin::create_for_testing(scenario.ctx());
    let fee = coin::mint_for_testing<SUI>(1, scenario.ctx());
    launch::launch<TCOIN, SUI>(
        &mut config,
        &pit,
        cap,
        &metadata,
        fee,
        pool::pit_holders(),
        false,
        &clock,
        scenario.ctx(),
    );
    transfer::public_freeze_object(metadata);
    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(clock);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 4)]
fun test_slippage_abort() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let clock = scenario.take_shared<Clock>();

    let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
    let tokens = pool::buy(&mut pool, &config, &mut pit, pay, 1_000_000_000, &clock, scenario.ctx());
    coin::burn_for_testing(tokens);

    scenario.return_shared(config);
    scenario.return_shared(pit);
    scenario.return_shared(pool);
    scenario.return_shared(clock);
    scenario.end();
}
