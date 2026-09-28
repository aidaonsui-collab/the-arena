#[test_only]
#[allow(deprecated_usage)]
module arena::iconq {
    /// Quote with an icon (mirrors XAUM/LOFI-style legacy metadata).
    public struct ICONQ has drop {}
    public fun otw(): ICONQ { ICONQ {} }
}

#[test_only]
#[allow(deprecated_usage)]
module arena::zukq {
    /// Quote with no icon, 6 decimals (ZUK-shaped).
    public struct ZUKQ has drop {}
    public fun otw(): ZUKQ { ZUKQ {} }
}

#[test_only]
#[allow(deprecated_usage)]
module arena::currency_quote_tests {

    use arena::lock;
    use sui::coin::{Self, CoinMetadata};
    use sui::coin_registry;
    use sui::test_utils;
    use sui::url;
    use arena::iconq;
    use arena::zukq;


    fun check_parity<Q>(meta: &CoinMetadata<Q>, ctx: &mut TxContext) {
        // CoinRegistry test constructor requires sender @0x0 (tx_context::dummy()).
        let mut registry = coin_registry::create_coin_data_registry_for_testing(ctx);
        let cur = coin_registry::migrate_legacy_metadata_for_testing(&mut registry, meta, ctx);
        let (ms, md, mi) = lock::quote_fields_from_metadata(meta);
        let (cs, cd, ci) = lock::quote_fields_from_currency(&cur);
        // Bluefin create_pool args must be byte-identical for either source.
        assert!(ms == cs, 0);
        assert!(md == cd, 1);
        assert!(mi == ci, 2);
        test_utils::destroy(cur);
        test_utils::destroy(registry);
    }

    #[test]
    fun currency_fields_match_metadata_with_icon() {
        let mut ctx = tx_context::dummy();
        let (cap, meta) = coin::create_currency(
            iconq::otw(), 9, b"XAUM", b"Mock XAUM", b"d",
            option::some(url::new_unsafe_from_bytes(b"https://example.com/xaum.png")),
            &mut ctx,
        );
        check_parity(&meta, &mut ctx);
        let (s, d, i) = lock::quote_fields_from_metadata(&meta);
        assert!(s == b"XAUM", 10);
        assert!(d == 9, 11);
        assert!(i == b"https://example.com/xaum.png", 12);
        test_utils::destroy(cap);
        test_utils::destroy(meta);
    }

    #[test]
    fun currency_fields_match_metadata_no_icon_6_dec() {
        let mut ctx = tx_context::dummy();
        let (cap, meta) = coin::create_currency(
            zukq::otw(), 6, b"ZUK", b"Zuk", b"d", option::none(), &mut ctx,
        );
        check_parity(&meta, &mut ctx);
        let (s, d, i) = lock::quote_fields_from_metadata(&meta);
        assert!(s == b"ZUK", 20);
        assert!(d == 6, 21);
        assert!(i == vector[], 22);
        test_utils::destroy(cap);
        test_utils::destroy(meta);
    }
}
