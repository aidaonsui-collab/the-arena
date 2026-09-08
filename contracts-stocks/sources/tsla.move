#[allow(deprecated_usage)]
/// Arena wrapped TSLA — 1:1 Sui wrapper for Robinhood Chain TSLA stock tokens.
module stocks::tsla {
    use sui::coin::{Self, TreasuryCap, CoinMetadata};
    use stocks::bridge::{Self, BridgeVault, MinterCap};

    /// One-time witness / coin type.
    public struct TSLA has drop {}

    fun init(otw: TSLA, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            otw,
            18,
            b"TSLA",
            b"Arena Wrapped TSLA",
            b"1:1 Arena wrap of Robinhood Chain TSLA. Lock RH → mint; burn → RH release.",
            option::none(),
            ctx,
        );
        let (vault, minter) = bridge::create_vault(treasury, b"TSLA", ctx);
        transfer::public_freeze_object(metadata);
        bridge::share_vault(vault);
        transfer::public_transfer(minter, ctx.sender());
    }

    #[test_only]
    public fun create_currency_for_testing(
        ctx: &mut TxContext,
    ): (TreasuryCap<TSLA>, CoinMetadata<TSLA>) {
        coin::create_currency(
            TSLA {},
            18,
            b"TSLA",
            b"Arena Wrapped TSLA",
            b"test",
            option::none(),
            ctx,
        )
    }

    #[test_only]
    public fun init_vault_for_testing(
        ctx: &mut TxContext,
    ): (BridgeVault<TSLA>, MinterCap, CoinMetadata<TSLA>) {
        let (treasury, metadata) = create_currency_for_testing(ctx);
        let (vault, minter) = bridge::create_vault(treasury, b"TSLA", ctx);
        (vault, minter, metadata)
    }
}
