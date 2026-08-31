/// Bytecode template for Create. Identifiers TEMPLATE/template and the six
/// constants are patched before publish.
///
/// Vector<u8> placeholders are unique (the compiler interns equal values) and
/// never longer than the shortest real field: shrinking a Vector(U8) constant
/// makes Sui reject the module with VMVerificationOrDeserializationError.
/// ICON is a 1-byte sentinel; init treats length < 2 as no icon so we can leave
/// it untouched when the user launches without art.
module coin_template::template {
    use sui::coin;
    use sui::url;

    public struct TEMPLATE has drop {}

    const DECIMALS: u8 = 9;
    const TOTAL_SUPPLY: u64 = 1_000_000_000_000_000;
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
        let (mut treasury, metadata) = coin::create_currency(
            otw, DECIMALS, SYMBOL, NAME, DESCRIPTION, icon, ctx
        );
        let minted = treasury.mint(TOTAL_SUPPLY, ctx);
        transfer::public_freeze_object(metadata);
        transfer::public_transfer(treasury, ctx.sender());
        transfer::public_transfer(minted, ctx.sender());
    }
}
