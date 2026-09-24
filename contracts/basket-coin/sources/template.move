/// Bytecode template for a basket share coin. Identifiers TEMPLATE/template
/// and the metadata constants are patched before publish.
///
/// Unlike `coin_template`, init does not mint. The basket vault must be the
/// first mint, against the creator seed. A pre-minted TreasuryCap is rejected
/// by `arena::basket::create`.
///
/// Vector<u8> placeholders stay unique and no longer than the shortest real
/// field. ICON length < 2 means no icon.
module basket_coin::template {
    use sui::coin;
    use sui::url;

    public struct TEMPLATE has drop {}

    const DECIMALS: u8 = 9;
    const SYMBOL: vector<u8> = b"S";
    const NAME: vector<u8> = b"N";
    const DESCRIPTION: vector<u8> = b"";
    const ICON: vector<u8> = b"-";

    #[allow(implicit_const_copy, deprecated_usage)]
    fun init(otw: TEMPLATE, ctx: &mut TxContext) {
        let icon = if (ICON.length() < 2) {
            option::none()
        } else {
            option::some(url::new_unsafe_from_bytes(ICON))
        };
        let (treasury, metadata) = coin::create_currency(
            otw, DECIMALS, SYMBOL, NAME, DESCRIPTION, icon, ctx
        );
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury, ctx.sender());
    }
}
