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
    // Pit<SUI> is created and registered by init. The QCOIN pit now needs the
    // AdminCap, which init sends to the platform wallet.
    scenario.next_tx(config::platform_wallet());
    let mut config = scenario.take_shared<Config>();
    let cap = scenario.take_from_sender<AdminCap>();
    config::create_pit<QCOIN>(&mut config, &cap, scenario.ctx());
    scenario.return_to_sender(cap);
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

/// `lock_graduated_lp` is AdminCap-gated now, so the fallback vault is opened
/// from the platform wallet in its own transaction.
fun lock_lp_admin(scenario: &mut Scenario) {
    scenario.next_tx(config::platform_wallet());
    let config = scenario.take_shared<Config>();
    let cap = scenario.take_from_sender<AdminCap>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let clock = scenario.take_shared<Clock>();
    lock::lock_graduated_lp_admin(&mut pool, &config, &cap, &clock, scenario.ctx());
    assert!(pool.lp_locked(), 0);
    scenario.return_to_sender(cap);
    ts::return_shared(config);
    ts::return_shared(pool);
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
        assert!(config.platform_value<SUI>() == 10, 21);
        // Nobody was registered when this fee was charged, so the 50 reflection
        // slice has no claim behind it and goes to the creator rather than into
        // a pot that could never be paid out: 20 creator + 50 = 70.
        assert!(pool.creator_pot_value() == 70, 2);
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
        transfer::public_transfer(tokens, USER2);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    // USER2's reflection fee goes to the holders registered when they paid it,
    // which is USER1 alone. USER2 no longer gets any of their own fee back.
    scenario.next_tx(USER1);
    {
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let refl = pool::claim_reflection(&mut pool, scenario.ctx());
        assert!(refl.value() > 0, 4);
        coin::burn_for_testing(refl);
        ts::return_shared(pool);
    };

    scenario.end();
}

/// M1 regression: a buyer must not be credited before their own trade's
/// reflection fee is distributed, or a dominant buyer refunds themselves.
#[test]
#[expected_failure(abort_code = 14)]
fun test_buyer_earns_nothing_from_own_reflection_fee() {
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
        transfer::public_transfer(tokens, USER1);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    // Sole buyer: every reflection fee they paid was distributed across the
    // holders registered before them, of whom there were none. Claiming aborts
    // with nothing_to_claim (14) rather than handing the fee back.
    scenario.next_tx(USER1);
    {
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let refl = pool::claim_reflection(&mut pool, scenario.ctx());
        coin::burn_for_testing(refl);
        ts::return_shared(pool);
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
        config::ring_pit(&mut pit, &config, &clock);
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
    config::ring_pit(&mut pit, &config, &clock);
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
        coin::burn_for_testing(tokens);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    lock_lp_admin(&mut scenario);

    scenario.next_tx(ADMIN);
    {
        let pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        assert!(pool.token_reserves() == 0, 2);
        assert!(pool.quote_reserves() == 0, 3);
        ts::return_shared(pool);
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
        coin::burn_for_testing(tokens);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    lock_lp_admin(&mut scenario);

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


// ---------------------------------------------------------------------------
// Audit regressions
//
// Each of these used to be a working exploit. Green means the hole is closed.
// ---------------------------------------------------------------------------

/// C1: the pot used to be returned to whoever called, with only a value check
/// on a `pool_id` argument. Anyone could read the winner off `BellEvent` and
/// take the pot.
#[test]
#[expected_failure(abort_code = 25)]
fun test_poc_outsider_cannot_take_pot() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let mut clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        transfer::public_transfer(tokens, USER1);
        clock.set_for_testing(2_000);
        config::ring_pit(&mut pit, &config, &clock);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    // USER2 knows the winning pool id and asks the pit for the pot directly.
    scenario.next_tx(USER2);
    {
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let stolen = pit::settle_to_holders(&mut pit, pool.id());
        stolen.destroy_zero();
        ts::return_shared(pit);
        ts::return_shared(pool);
    };

    scenario.end();
}

/// C1, burn-mode twin of the above.
#[test]
#[expected_failure(abort_code = 25)]
fun test_poc_outsider_cannot_take_burn_pot() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    scenario.next_tx(USER2);
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let pit_id = pit.id();
    let stolen = pit::settle_burn_quote(&mut pit, pit_id);
    stolen.destroy_zero();
    ts::return_shared(pit);
    scenario.end();
}

/// C2: `metric` and `pool_id` were caller-supplied, so anyone could take the
/// lead with u64::MAX and win every round.
#[test]
#[expected_failure(abort_code = 25)]
fun test_poc_outsider_cannot_claim_the_lead() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    scenario.next_tx(USER2);
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let clock = scenario.take_shared<Clock>();
    let pit_id = pit.id();
    pit::nudge(&mut pit, pit_id, 18446744073709551615, false, 1_000, &clock);
    ts::return_shared(pit);
    ts::return_shared(clock);
    scenario.end();
}

/// C3: `round_ms` was a caller argument, so one call could push the bell years
/// out and freeze the pot forever.
#[test]
#[expected_failure(abort_code = 25)]
fun test_poc_outsider_cannot_set_round_length() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);

    scenario.next_tx(USER2);
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let clock = scenario.take_shared<Clock>();
    pit::ring(&mut pit, 315_360_000_000, &clock);
    ts::return_shared(pit);
    ts::return_shared(clock);
    scenario.end();
}

/// C3: and the round length the honest bell uses is bounded at the setter.
#[test]
#[expected_failure(abort_code = 30)]
fun test_round_ms_is_bounded() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    scenario.next_tx(config::platform_wallet());
    let mut config = scenario.take_shared<Config>();
    let cap = scenario.take_from_sender<AdminCap>();
    config::set_round_ms(&mut config, &cap, 315_360_000_000);
    scenario.return_to_sender(cap);
    ts::return_shared(config);
    scenario.end();
}

/// C4: buy from A, hand the coin to B, sell from B — A used to keep its
/// dividend weight forever while `total_registered` never came down.
#[test]
#[expected_failure(abort_code = 27)]
fun test_poc_transfer_then_sell_from_fresh_wallet() {
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
        // The coin moves to a wallet the registry has never seen.
        transfer::public_transfer(tokens, USER2);
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
        let tokens = scenario.take_from_sender<coin::Coin<TCOIN>>();
        assert!(pool.holder_amount(USER1) > 0, 0);
        let out = pool::sell(&mut pool, &mut config, &mut pit, tokens, 0, &clock, scenario.ctx());
        coin::burn_for_testing(out);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.end();
}

/// C4: and the wallet that did buy can still sell its own position.
#[test]
fun test_buyer_can_still_sell_their_own_position() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let clock = scenario.take_shared<Clock>();

    let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
    let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
    let bought = tokens.value();
    assert!(pool.holder_amount(USER1) == bought, 0);

    let out = pool::sell(&mut pool, &mut config, &mut pit, tokens, 0, &clock, scenario.ctx());
    assert!(out.value() > 0, 1);
    assert!(pool.holder_amount(USER1) == 0, 2);
    assert!(pool.total_registered() == 0, 3);

    coin::burn_for_testing(out);
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
    scenario.end();
}

/// H2: `lock_graduated_lp` raced the Bluefin seed for a one-shot flag, and both
/// were permissionless. Winning that race meant the token never got a market.
#[test]
#[expected_failure(abort_code = 25)]
fun test_poc_outsider_cannot_divert_graduation() {
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
    assert!(pool.is_graduated(), 0);
    lock::lock_graduated_lp(&mut pool, &config, &clock, scenario.ctx());
    coin::burn_for_testing(tokens);
    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
    scenario.end();
}

/// H4: graduation is measured on the quote actually in the curve, so a
/// buy → sell cycle no longer walks a pool over the line.
#[test]
fun test_wash_trading_does_not_graduate() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    let mut config = scenario.take_shared<Config>();
    let mut pit = scenario.take_shared<Pit<SUI>>();
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let clock = scenario.take_shared<Clock>();

    // Threshold is 50_000. Five round trips of 20_000 push `raised` well past
    // it while the real reserve keeps coming back down.
    let mut i = 0u64;
    while (i < 5) {
        let pay = coin::mint_for_testing<SUI>(20_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        let out = pool::sell(&mut pool, &mut config, &mut pit, tokens, 0, &clock, scenario.ctx());
        coin::burn_for_testing(out);
        i = i + 1;
    };

    assert!(pool.raised() > 50_000, 0);
    assert!(pool.quote_reserves() < 50_000, 1);
    assert!(!pool.is_graduated(), 2);

    ts::return_shared(config);
    ts::return_shared(pit);
    ts::return_shared(pool);
    ts::return_shared(clock);
    scenario.end();
}

/// H1: the pit that collects the fee is the one `Config` names, not the one the
/// caller passed.
#[test]
#[expected_failure(abort_code = 26)]
fun test_poc_cannot_route_fee_to_own_pit() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    // Note the pit Config currently points at.
    scenario.next_tx(ADMIN);
    let canonical = {
        let pit = scenario.take_shared<Pit<SUI>>();
        let id = pit.id();
        ts::return_shared(pit);
        id
    };

    // A second SUI pit is shared and Config is repointed at it. Trading against
    // the now-stale pit aborts — the same check that stops a pit an attacker
    // shared from ever collecting a fee.
    scenario.next_tx(config::platform_wallet());
    {
        let mut config = scenario.take_shared<Config>();
        let cap = scenario.take_from_sender<AdminCap>();
        config::create_pit<SUI>(&mut config, &cap, scenario.ctx());
        assert!(*config::canonical_pit<SUI>(&config).borrow() != canonical, 0);
        scenario.return_to_sender(cap);
        ts::return_shared(config);
    };

    scenario.next_tx(USER1);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = ts::take_shared_by_id<Pit<SUI>>(&scenario, canonical);
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        coin::burn_for_testing(tokens);
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.end();
}

/// H3: the fee-less curve buy is reachable only through `settle_pit` now, so it
/// cannot be used to set the price the Bluefin pool is seeded at.
#[test]
#[expected_failure(abort_code = 25)]
fun test_poc_outsider_cannot_move_reserves() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER2);
    let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
    let quote = coin::mint_for_testing<SUI>(50_000, scenario.ctx());
    pool::burn_from_pit(&mut pool, quote.into_balance(), scenario.ctx());
    ts::return_shared(pool);
    scenario.end();
}

/// H5: settling to a pool with nothing registered would strand the whole pot
/// in an unclaimable bag. It stays in the pit instead.
#[test]
#[expected_failure(abort_code = 28)]
fun test_settle_to_empty_pool_does_not_strand_the_pot() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    launch_sui(&mut scenario, ADMIN, pool::pit_holders(), false);

    scenario.next_tx(USER1);
    {
        let mut config = scenario.take_shared<Config>();
        let mut pit = scenario.take_shared<Pit<SUI>>();
        let mut pool = scenario.take_shared<Pool<TCOIN, SUI>>();
        let mut clock = scenario.take_shared<Clock>();
        let pay = coin::mint_for_testing<SUI>(10_000, scenario.ctx());
        let tokens = pool::buy(&mut pool, &mut config, &mut pit, pay, 0, &clock, scenario.ctx());
        // The only holder exits, so nothing is registered when the bell rings.
        let out = pool::sell(&mut pool, &mut config, &mut pit, tokens, 0, &clock, scenario.ctx());
        coin::burn_for_testing(out);
        assert!(pool.total_registered() == 0, 0);
        clock.set_for_testing(2_000);
        config::ring_pit(&mut pit, &config, &clock);
        pool::settle_pit(&mut pool, &mut pit, scenario.ctx());
        ts::return_shared(config);
        ts::return_shared(pit);
        ts::return_shared(pool);
        ts::return_shared(clock);
    };

    scenario.end();
}

/// The retired `create_pit` cannot be used to share a rival pot.
#[test]
#[expected_failure(abort_code = 25)]
fun test_poc_outsider_cannot_open_a_pit() {
    let mut scenario = ts::begin(ADMIN);
    setup(&mut scenario);
    scenario.next_tx(USER2);
    pit::create_pit<SUI>(scenario.ctx());
    scenario.end();
}
