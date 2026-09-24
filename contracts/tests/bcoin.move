#[allow(deprecated_usage)]
#[test_only]
module arena::bcoin {
    use sui::coin::{Self, TreasuryCap, CoinMetadata};

    public struct BCOIN has drop {}

    public fun treasury(ctx: &mut TxContext): (TreasuryCap<BCOIN>, CoinMetadata<BCOIN>) {
        coin::create_currency(BCOIN {}, 9, b"BSK", b"Basket", b"basket share test", option::none(), ctx)
    }
}
