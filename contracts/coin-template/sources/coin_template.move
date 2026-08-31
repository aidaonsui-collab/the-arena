#[allow(deprecated_usage)]
module template::template;

use sui::coin;
use sui::url;

/// One-time witness. The identifier is patched to the token's ticker at publish
/// time; the module name below is patched to its lowercase form.
public struct TEMPLATE has drop {}

/// Patched before publish. Every literal here is a constant in the compiled
/// module, which is what makes it reachable from `update_constants`.
const DECIMALS: u8 = 9;
const SUPPLY: u64 = 1_000_000_000_000_000;
const SYMBOL: vector<u8> = b"TMPL";
const NAME: vector<u8> = b"Template";
const DESCRIPTION: vector<u8> = b"DESCRIPTION_PLACEHOLDER";
const ICON: vector<u8> = b"ICON_PLACEHOLDER";

fun init(witness: TEMPLATE, ctx: &mut TxContext) {
    let icon = if (ICON.length() == 0) {
        option::none()
    } else {
        option::some(url::new_unsafe_from_bytes(ICON))
    };

    let (mut treasury, metadata) = coin::create_currency(
        witness,
        DECIMALS,
        SYMBOL,
        NAME,
        DESCRIPTION,
        icon,
        ctx,
    );

    // Whole supply to the creator, so they have a Coin<T> to seed LP with.
    let minted = coin::mint(&mut treasury, SUPPLY, ctx);
    transfer::public_transfer(minted, ctx.sender());

    // Metadata is frozen: `launch_instadex` only needs to read it, and a
    // mutable metadata object is a rug vector for renaming a live token.
    transfer::public_freeze_object(metadata);

    // TreasuryCap goes to the creator, who hands it to `launch_instadex`,
    // which locks it in an InstadexMintLock forever. No mint after launch.
    transfer::public_transfer(treasury, ctx.sender());
}
