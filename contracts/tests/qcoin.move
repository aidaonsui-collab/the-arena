#[test_only]
#[allow(deprecated_usage)]
module arena::qcoin {
    use sui::coin::{Self, TreasuryCap, CoinMetadata, Coin};

    public struct QCOIN has drop {}

    public fun create(ctx: &mut TxContext): (TreasuryCap<QCOIN>, CoinMetadata<QCOIN>) {
        coin::create_currency(QCOIN {}, 9, b"XAUM", b"Mock XAUM", b"test quote standing in for XAUM", option::none(), ctx)
    }

    public fun mint(cap: &mut TreasuryCap<QCOIN>, amount: u64, ctx: &mut TxContext): Coin<QCOIN> {
        coin::mint(cap, amount, ctx)
    }
}
