#[test_only]
module arena::arena_tests;

use arena::config::{Self, Config, AdminCap};
use arena::qcoin::QCOIN;
use arena::launch::{Self, InstadexMintLock};
use arena::lock::{Self, LpLock};
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
const LP_LOCK_MS: u64 = 15_552_000_000;

fun setup(scenario: &mut Scenario) {
    config::init_for_testing(scenario.ctx());
    pit::create_pit<QCOIN>(scenario.ctx());
    scenario.next_tx(ADMIN);
    let mut config = scenario.take_shared<Config>();
    config.set_for_testing(
        1_000,
        100,
        50_000,
        50_000,
        10_000,
        10_000,
        1_000_000,
        1_000,
    );
    ts::return_shared(config);
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
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(clock);
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
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(clock);
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
    let mut tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
    // 1% swap fee on quote in; 60/10/30 creator/platform/pit; no reflection
    assert!(pool.raised() == 9_900, 1);
    assert!(pit.pot_value() == 30, 2);
    assert!(pool.creator_pot_value() == 60, 3);
    assert!(config.platform_value<SUI>() == 10, 4);
    assert!(tokens.value() > 0, 5);

    let half_amt = tokens.value() / 2;
    let half = tokens.split(half_amt, scenario.ctx());
    let quote_back = pool::sell(&mut pool, &mut config, &mut pit, half, 0, &clock, scenario.ctx());
    assert!(quote_back.value() > 0, 6);
    assert!(pit.pot_value() > 30, 7);
    // cumulative raised does not fall on sell
    assert!(pool.raised() == 9_900, 8);

    coin::burn_for_testing(tokens);
    coin::burn_for_testing(quote_back);
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
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
    let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
    assert!(pool.raised() == 9_900, 0);
    assert!(pit.pot_value() == 30, 1);
    assert!(pool.creator_pot_value() == 60, 2);
    assert!(tokens.value() > 0, 3);

    coin::burn_for_testing(tokens);
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
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
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        // reflection split: 50/20/20/10 refl/creator/pit/platform. raised 9900.
        assert!(pool.raised() == 9_900, 0);
        assert!(pit.pot_value() == 20, 1);
        assert!(pool.creator_pot_value() == 20, 2);
        assert!(config.platform_value<SUI>() == 10, 21);
        transfer::public_transfer(tokens, USER1);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.next_tx(USER2);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        assert!(pit.pot_value() == 40, 3);
        let refl = pool::claim_reflection(&mut pool, scenario.ctx());
        assert!(refl.value() > 0, 4);
        coin::burn_for_testing(tokens);
        coin::burn_for_testing(refl);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
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
    let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
    // 60000 * 0.99 = 59400 >= 50000
    assert!(pool.raised() >= 50_000, 0);
    assert!(pool.raised() == 59_400, 1);
    assert!(pool.is_graduated(), 2);

    coin::burn_for_testing(tokens);
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
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
    let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
    coin::burn_for_testing(tokens);
    assert!(pool.is_graduated(), 0);

    let pay2 = coin::mint_for_testing<SUI>(1_000, scenario.ctx());
    let tokens2 = pool::buy(&mut pool, &mut config, &mut pit, pay2, 0, &clock, scenario.ctx());
    coin::burn_for_testing(tokens2);

    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
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
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        transfer::public_transfer(tokens, USER1);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.next_tx(USER2);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        transfer::public_transfer(tokens, USER2);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
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
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.next_tx(USER1);
    {
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let c = pool::claim_pit(&mut pool, scenario.ctx());
        assert!(c.value() > 0, 1);
        coin::burn_for_testing(c);
        ts::return_shared(pool);
    };

    scenario.next_tx(USER2);
    {
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let c = pool::claim_pit(&mut pool, scenario.ctx());
        assert!(c.value() > 0, 2);
        coin::burn_for_testing(c);
        ts::return_shared(pool);
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
    let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
    let reserve_before = pool.token_reserves();
    let supply_before = pool.total_supply();
    assert!(pit.pot_value() == 30, 0);

    clock.set_for_testing(2_000);
    pit::ring(&mut pit, config.round_ms(), &clock);
    pool::settle_pit(&mut pool, &mut pit, scenario.ctx());

    assert!(pool.token_reserves() < reserve_before, 1);
    assert!(pool.total_supply() < supply_before, 2);
    assert!(pit.pot_value() == 0, 3);

    coin::burn_for_testing(tokens);
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
    scenario.end();
}

#[test]
fun test_creator_claim() {
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
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        assert!(pool.creator_pot_value() == 60, 0);
        coin::burn_for_testing(tokens);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.next_tx(ADMIN);
    {
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let c = pool::claim_creator(&mut pool, scenario.ctx());
        assert!(c.value() == 60, 1);
        assert!(pool.creator_pot_value() == 0, 2);
        coin::burn_for_testing(c);
        ts::return_shared(pool);
    };

    scenario.end();
}

#[test]
fun test_admin_cap_to_odyssey_wallet() {
    let mut scenario = ts::begin(ADMIN);
    config::init_for_testing(scenario.ctx());
    scenario.next_tx(config::platform_wallet());
    let cap = scenario.take_from_sender<AdminCap>();
    assert!(
        config::platform_wallet() == @0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b,
        0,
    );
    ts::return_to_sender(&scenario, cap);
    scenario.end();
}

#[test]
fun test_lp_lock() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(60_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        assert!(pool.is_graduated(), 0);
        lock::lock_graduated_lp(&mut pool, &config, &clock, scenario.ctx());
        assert!(pool.lp_locked(), 1);
        assert!(pool.token_reserves() == 0, 2);
        assert!(pool.quote_reserves() == 0, 3);
        coin::burn_for_testing(tokens);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<LpLock<TCOIN, SUI>>();
        let mut clock = scenario.take_shared<Clock>();
        assert!(lock.beneficiary() == ADMIN, 4);
        assert!(lock.unlock_ms() == 1 + LP_LOCK_MS, 5);
        clock.set_for_testing(1 + LP_LOCK_MS);
        let (tok, quote) = lock::claim_lp(&mut lock, &clock, scenario.ctx());
        assert!(tok.value() > 0, 6);
        assert!(quote.value() > 0, 7);
        assert!(lock.token_value() == 0, 8);
        assert!(lock.quote_value() == 0, 9);
        coin::burn_for_testing(tok);
        coin::burn_for_testing(quote);
        ts::return_shared(lock);
        ts::return_shared(clock);
    };

    scenario.end();
}

#[test]
#[expected_failure(abort_code = 20)]
fun test_lp_claim_too_early() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(60_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        lock::lock_graduated_lp(&mut pool, &config, &clock, scenario.ctx());
        coin::burn_for_testing(tokens);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.next_tx(ADMIN);
    {
        let mut lock = scenario.take_shared<LpLock<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let (tok, quote) = lock::claim_lp(&mut lock, &clock, scenario.ctx());
        coin::burn_for_testing(tok);
        coin::burn_for_testing(quote);
        ts::return_shared(lock);
        ts::return_shared(clock);
    };

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
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(clock);
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
    let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 1_000_000_000, &clock, scenario.ctx());
    coin::burn_for_testing(tokens);

    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
    scenario.end();
}

#[test]
fun test_sqrt_and_tick_align() {
    use arena::math;
    assert!(math::sqrt_u256(0) == 0, 0);
    assert!(math::sqrt_u256(1) == 1, 1);
    assert!(math::sqrt_u256(4) == 2, 2);
    assert!(math::sqrt_u256(9) == 3, 3);
    assert!(math::sqrt_u256(10) == 3, 4);
    // sqrt(1)*2^64
    assert!(math::sqrt_price_x64(1, 1) == math::q64(), 5);
    // sqrt(1/4)*2^64 = 2^63
    assert!(math::sqrt_price_x64(4, 1) == 9223372036854775808, 6);
    // Verified GlobalConfig ticks snapped to spacing 60.
    // min_tick.bits = 4294523660 (−443636), max = 443636.
    // 443636 % 60 = 56 → aligned 443580; −443580 bits = 4294523716.
    assert!(math::align_tick_bits(443636, 60) == 443580, 7);
    assert!(math::align_tick_bits(4294523660, 60) == 4294523716, 8);
    assert!(math::align_tick_bits(443636, 1) == 443636, 9);
}

#[test]
fun test_instadex_mint_lock() {
    let mut scenario = ts::begin(ADMIN);
    let (cap, metadata) = tcoin::create_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);
    launch::share_mint_lock_for_testing(cap, scenario.ctx());
    scenario.next_tx(ADMIN);
    let mint_lock = scenario.take_shared<InstadexMintLock<TCOIN>>();
    ts::return_shared(mint_lock);
    scenario.end();
}

#[test]
fun test_instadex_mint_lock_burn() {
    let mut scenario = ts::begin(ADMIN);
    let (mut cap, metadata) = tcoin::create_for_testing(scenario.ctx());
    let minted = tcoin::mint(&mut cap, 1_000, scenario.ctx());
    assert!(coin::total_supply(&cap) == 1_000, 0);
    transfer::public_freeze_object(metadata);
    launch::share_mint_lock_for_testing(cap, scenario.ctx());
    scenario.next_tx(ADMIN);
    let mut mint_lock = scenario.take_shared<InstadexMintLock<TCOIN>>();
    assert!(launch::mint_lock_supply(&mint_lock) == 1_000, 1);
    launch::burn_from_mint_lock(&mut mint_lock, minted);
    assert!(launch::mint_lock_supply(&mint_lock) == 0, 2);
    // zero coin is destroyed, not burned
    let zero = coin::zero<TCOIN>(scenario.ctx());
    launch::burn_from_mint_lock(&mut mint_lock, zero);
    assert!(launch::mint_lock_supply(&mint_lock) == 0, 3);
    ts::return_shared(mint_lock);
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 3)]
fun test_instadex_zero_amounts_abort() {
    // Mirrors launch_instadex's check, which runs before any Bluefin CALL.
    launch::assert_instadex_amounts(0, 1_000);
}

#[test]
#[expected_failure(abort_code = 20)]
fun test_permanent_bluefin_lock_unclaimable() {
    let mut scenario = ts::begin(ADMIN);
    let mut clock = clock::create_for_testing(scenario.ctx());
    clock.set_for_testing(1);
    lock::share_bluefin_lock_for_testing(
        sui::object::id_from_address(@0x0),
        sui::object::id_from_address(@0x0),
        ADMIN,
        0,
        scenario.ctx(),
    );
    clock.share_for_testing();
    scenario.next_tx(ADMIN);
    let mut bf_lock = scenario.take_shared<lock::BluefinPositionLock>();
    let clock = scenario.take_shared<Clock>();
    let pos = lock::claim_bluefin_position(&mut bf_lock, &clock, scenario.ctx());
    transfer::public_transfer(pos, ADMIN);
    ts::return_shared(bf_lock);
    ts::return_shared(clock);
    scenario.end();
}

#[test]
fun test_split_std_lp_quote() {
    let (c, p, pit) = lock::split_std_lp_quote(10_000, 6_000, 1_000, 3_000);
    assert!(c == 6_000, 0);
    assert!(p == 1_000, 1);
    assert!(pit == 3_000, 2);
    assert!(c + p + pit == 10_000, 3);

    let (c, p, pit) = lock::split_std_lp_quote(1, 6_000, 1_000, 3_000);
    assert!(c == 1, 4);
    assert!(p == 0, 5);
    assert!(pit == 0, 6);

    let (c, p, pit) = lock::split_std_lp_quote(7, 6_000, 1_000, 3_000);
    assert!(c + p + pit == 7, 7);
    assert!(p == 0, 8);
    assert!(pit == 2, 9);
    assert!(c == 5, 10);

    let (c, p, pit) = lock::split_std_lp_quote(0, 6_000, 1_000, 3_000);
    assert!(c == 0 && p == 0 && pit == 0, 11);

    // 80 LP quote from a 0.01 SUI swap's 1% * 80% share
    let (c, p, pit) = lock::split_std_lp_quote(80_000, 6_000, 1_000, 3_000);
    assert!(c == 48_000, 12);
    assert!(p == 8_000, 13);
    assert!(pit == 24_000, 14);
}

#[test]
#[expected_failure(abort_code = 23)]
fun test_legacy_collect_bluefin_fees_aborts() {
    lock::abort_legacy_collect();
}

#[test]
#[expected_failure(abort_code = 24)]
fun test_collect_lp_fees_aborts() {
    lock::abort_instadex_collect();
}

