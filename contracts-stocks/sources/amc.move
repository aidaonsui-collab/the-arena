#[allow(deprecated_usage)]
/// Arena wrapped AMC — 1:1 Sui wrapper for Robinhood Chain AMC stock tokens.
module stocks::amc {
    use sui::coin::{Self, TreasuryCap, CoinMetadata};
    use stocks::bridge::{Self, BridgeVault, MinterCap};

    /// One-time witness / coin type.
    public struct AMC has drop {}

    fun init(otw: AMC, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            otw,
            18,
            b"AMC",
            b"Arena Wrapped AMC",
            b"1:1 Arena wrap of Robinhood Chain AMC. Lock RH → mint; burn → RH release.",
            option::none(),
            ctx,
        );
        let (vault, minter) = bridge::create_vault(treasury, b"AMC", ctx);
        transfer::public_freeze_object(metadata);
        bridge::share_vault(vault);
        transfer::public_transfer(minter, ctx.sender());
    }

    #[test_only]
    public fun create_currency_for_testing(
        ctx: &mut TxContext,
    ): (TreasuryCap<AMC>, CoinMetadata<AMC>) {
        coin::create_currency(
            AMC {},
            18,
            b"AMC",
            b"Arena Wrapped AMC",
            b"test",
            option::none(),
            ctx,
        )
    }

    #[test_only]
    public fun init_vault_for_testing(
        ctx: &mut TxContext,
    ): (BridgeVault<AMC>, MinterCap, CoinMetadata<AMC>) {
        let (treasury, metadata) = create_currency_for_testing(ctx);
        let (vault, minter) = bridge::create_vault(treasury, b"AMC", ctx);
        (vault, minter, metadata)
    }
}
