#[test_only]
module arena::tcoin {
    use sui::coin::{Self, TreasuryCap, CoinMetadata, Coin};

    public struct TCOIN has drop {}

    public fun create(ctx: &mut TxContext): (TreasuryCap<TCOIN>, CoinMetadata<TCOIN>) {
        coin::create_currency(TCOIN {}, 9, b"TST", b"Test", b"arena test", option::none(), ctx)
    }

    public fun create_for_testing(ctx: &mut TxContext): (TreasuryCap<TCOIN>, CoinMetadata<TCOIN>) {
        create(ctx)
    }

    public fun mint(cap: &mut TreasuryCap<TCOIN>, amount: u64, ctx: &mut TxContext): Coin<TCOIN> {
        coin::mint(cap, amount, ctx)
    }
}
