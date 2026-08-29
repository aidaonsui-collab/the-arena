#[test_only]
module arena::tcoin2;

use std::option;
use sui::coin::{Self, TreasuryCap, CoinMetadata};
use sui::url::Url;

public struct TCOIN2 has drop {}

#[allow(deprecated_usage)]
public fun create_for_testing(ctx: &mut TxContext): (TreasuryCap<TCOIN2>, CoinMetadata<TCOIN2>) {
    coin::create_currency<TCOIN2>(
        TCOIN2 {},
        9,
        b"TC2",
        b"Test Coin 2",
        b"Arena second test coin",
        option::none<Url>(),
        ctx,
    )
}
