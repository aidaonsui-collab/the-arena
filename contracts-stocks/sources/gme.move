#[allow(deprecated_usage)]
/// Arena wrapped GME — 1:1 Sui wrapper for Robinhood Chain GME stock tokens.
module stocks::gme {
    use sui::coin::{Self, TreasuryCap, CoinMetadata};
    use stocks::bridge::{Self, BridgeVault, MinterCap};

    /// One-time witness / coin type.
    public struct GME has drop {}

    fun init(otw: GME, ctx: &mut TxContext) {
        let (treasury, metadata) = coin::create_currency(
            otw,
            // 9, not 18. Sui amounts are u64, so at 18 decimals the largest
            // mintable balance is ~18.44 shares — a normal position would lock
            // on RH with nothing minted. At 9 the ceiling is ~18.4bn shares and
            // the attestor scales RH 1e18 base units down by 1e9 on the way in.
            9,
            b"GME",
            b"Arena Wrapped GME",
            b"1:1 Arena wrap of Robinhood Chain GME (9dp). Lock RH → mint; burn → RH release.",
            option::none(),
            ctx,
        );
        let (vault, minter) = bridge::create_vault(treasury, b"GME", ctx);
        transfer::public_freeze_object(metadata);
        bridge::share_vault(vault);
        transfer::public_transfer(minter, ctx.sender());
    }

    #[test_only]
    public fun create_currency_for_testing(
        ctx: &mut TxContext,
    ): (TreasuryCap<GME>, CoinMetadata<GME>) {
        coin::create_currency(
            GME {},
            18,
            b"GME",
            b"Arena Wrapped GME",
            b"test",
            option::none(),
            ctx,
        )
    }

    #[test_only]
    public fun init_vault_for_testing(
        ctx: &mut TxContext,
    ): (BridgeVault<GME>, MinterCap, CoinMetadata<GME>) {
        let (treasury, metadata) = create_currency_for_testing(ctx);
        let (vault, minter) = bridge::create_vault(treasury, b"GME", ctx);
        (vault, minter, metadata)
    }
}
