#[test_only]
module stocks::bridge_tests;

use stocks::amc;
use stocks::bridge;
use stocks::nvda::{Self, NVDA};
use sui::coin::{Self, Coin};
use sui::test_scenario::{Self as ts};

const ADMIN: address = @0xAD;
const USER: address = @0xB1;

#[test]
fun mint_then_burn_supply_zero() {
    let mut scenario = ts::begin(ADMIN);

    let (mut vault, minter, metadata) = nvda::init_vault_for_testing(scenario.ctx());
    transfer::public_freeze_object(metadata);

    assert!(bridge::total_supply(&vault) == 0, 0);

    let amount = 1_000_000_000_000_000_000; // 1 NVDA @ 18 decimals
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

    bridge::burn(&mut vault, wrapped, scenario.ctx());
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
