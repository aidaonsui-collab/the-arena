#[test_only]
module stocks::bridge_tests;

use stocks::amc;
use stocks::bridge;
use stocks::nvda::{Self, NVDA};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts};

const ADMIN: address = @0xAD;
const USER: address = @0xB1;
// A well-formed 20-byte EVM address, arbitrary for tests.
const RH_DEST: vector<u8> = x"1111111111111111111111111111111111111111";

#[test]
fun mint_then_burn_supply_zero() {
    let mut scenario = ts::begin(ADMIN);

    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);

    assert!(bridge::total_supply(&vault) == 0, 0);

    let amount = 1_000_000_000; // 1 NVDA @ 9 decimals
    bridge::mint(
        &mut vault,
        &minter,
        amount,
        USER,
        b"rh-lock-attestation-demo",
        scenario.ctx(),
    );
    assert!(bridge::total_supply(&vault) == amount, 1);

    scenario.next_tx(USER);
    let wrapped = scenario.take_from_sender<Coin<NVDA>>();
    assert!(coin::value(&wrapped) == amount, 2);

    bridge::burn(&mut vault, wrapped, RH_DEST, scenario.ctx());
    assert!(bridge::total_supply(&vault) == 0, 3);

    bridge::destroy_minter_for_testing(minter);
    bridge::destroy_vault_for_testing(vault, scenario.ctx());
    scenario.end();
}

#[test]
#[expected_failure(abort_code = 1)]
fun unauthorized_mint_aborts() {
    let mut scenario = ts::begin(ADMIN);

    let (mut vault_nvda, minter_nvda, meta_n) = nvda::init_vault_for_testing(scenario.ctx());
    let (vault_amc, minter_amc, meta_a) = amc::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(meta_n);
    transfer::public_freeze_object(meta_a);

    // Wrong MinterCap (AMC's) against NVDA vault → EUnauthorized
    bridge::mint(
        &mut vault_nvda,
        &minter_amc,
        1,
        USER,
        b"should-fail",
        scenario.ctx(),
    );

    // Unreachable cleanup (keeps compiler happy about unused values if abort path changes)
    bridge::destroy_minter_for_testing(minter_nvda);
    bridge::destroy_minter_for_testing(minter_amc);
    bridge::destroy_vault_for_testing(vault_nvda, scenario.ctx());
    bridge::destroy_vault_for_testing(vault_amc, scenario.ctx());
    scenario.end();
}

#[test]
fun minter_bound_to_vault_id() {
    let mut scenario = ts::begin(ADMIN);
    let (vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);
    assert!(bridge::vault_id_of_minter(&minter) == bridge::vault_id(&vault), 0);
    assert!(bridge::ticker(&vault) == b"NVDA", 1);
    bridge::destroy_minter_for_testing(minter);
    bridge::destroy_vault_for_testing(vault, scenario.ctx());
    scenario.end();
}

/// BRG-02: the same RH lock must not mint twice, even if the attestor asks.
#[test]
#[expected_failure(abort_code = stocks::bridge::EAlreadyMinted)]
fun replaying_an_rh_ref_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);

    let rh_ref = b"0xdeadbeef:7";
    bridge::mint(&mut vault, &minter, 1_000_000_000, USER, rh_ref, scenario.ctx());
    assert!(bridge::is_minted(&vault, rh_ref), 0);

    // A restart on an empty dedupe store, or a second watcher, replays this.
    bridge::mint(&mut vault, &minter, 1_000_000_000, USER, rh_ref, scenario.ctx());

    abort 42
}

/// An empty rh_ref cannot be deduplicated, so it is refused outright.
#[test]
#[expected_failure(abort_code = stocks::bridge::EEmptyRhRef)]
fun empty_rh_ref_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);
    bridge::mint(&mut vault, &minter, 1_000_000_000, USER, b"", scenario.ctx());
    abort 42
}

/// Distinct locks still mint independently, and the guard tracks each one.
#[test]
fun distinct_rh_refs_both_mint() {
    let mut scenario = ts::begin(ADMIN);
    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);

    assert!(!bridge::is_minted(&vault, b"lock-1"), 0);
    bridge::mint(&mut vault, &minter, 1_000_000_000, USER, b"lock-1", scenario.ctx());
    bridge::mint(&mut vault, &minter, 2_000_000_000, USER, b"lock-2", scenario.ctx());

    assert!(bridge::is_minted(&vault, b"lock-1"), 1);
    assert!(bridge::is_minted(&vault, b"lock-2"), 2);
    assert!(!bridge::is_minted(&vault, b"lock-3"), 3);
    assert!(bridge::total_supply(&vault) == 3_000_000_000, 4);

    scenario.next_tx(USER);
    let a = scenario.take_from_sender<Coin<NVDA>>();
    let b = scenario.take_from_sender<Coin<NVDA>>();
    bridge::burn(&mut vault, a, RH_DEST, scenario.ctx());
    bridge::burn(&mut vault, b, RH_DEST, scenario.ctx());

    bridge::destroy_minter_for_testing(minter);
    bridge::destroy_vault_for_testing(vault, scenario.ctx());
    scenario.end();
}

/// BRG-01: a realistic position fits now. At 18 decimals, 100 shares was
/// 1e20 base units — over u64 max — so the mint was refused and the RH
/// deposit sat locked with nothing issued.
#[test]
fun a_hundred_shares_fits_in_u64() {
    let mut scenario = ts::begin(ADMIN);
    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);

    let hundred_shares = 100_000_000_000; // 100 @ 9dp
    bridge::mint(&mut vault, &minter, hundred_shares, USER, b"lock-big", scenario.ctx());
    assert!(bridge::total_supply(&vault) == hundred_shares, 0);

    scenario.next_tx(USER);
    let c = scenario.take_from_sender<Coin<NVDA>>();
    bridge::burn(&mut vault, c, RH_DEST, scenario.ctx());

    bridge::destroy_minter_for_testing(minter);
    bridge::destroy_vault_for_testing(vault, scenario.ctx());
    scenario.end();
}

/// The whole point of rh_dest: a Sui address is never a usable RH release
/// target, so an absent/malformed destination is refused at burn time
/// instead of silently emitting a RedeemBurned no releaser can act on.
#[test]
#[expected_failure(abort_code = stocks::bridge::EBadRhDest)]
fun empty_rh_dest_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);

    bridge::mint(&mut vault, &minter, 1_000_000_000, USER, b"lock-1", scenario.ctx());
    scenario.next_tx(USER);
    let c = scenario.take_from_sender<Coin<NVDA>>();
    bridge::burn(&mut vault, c, b"", scenario.ctx());
    abort 42
}

/// A too-short destination (e.g. a truncated paste) is refused the same way.
#[test]
#[expected_failure(abort_code = stocks::bridge::EBadRhDest)]
fun short_rh_dest_aborts() {
    let mut scenario = ts::begin(ADMIN);
    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);

    bridge::mint(&mut vault, &minter, 1_000_000_000, USER, b"lock-1", scenario.ctx());
    scenario.next_tx(USER);
    let c = scenario.take_from_sender<Coin<NVDA>>();
    bridge::burn(&mut vault, c, x"1111", scenario.ctx());
    abort 42
}
