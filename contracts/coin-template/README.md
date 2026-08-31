# Coin template

Sui gives every coin type its own Move module with a one-time witness, so a coin
cannot be minted into existence by an already-deployed package: a launchpad has
to publish a module per token. This is the module the launch page publishes on
the creator's behalf.

`sources/coin_template.move` is compiled once, here, and its bytecode is pasted
into `COIN_TEMPLATE_B64` in `index.html`. The browser then patches it per launch
with `@mysten/move-bytecode-template`:

- **identifiers** `TEMPLATE` → the ticker uppercased, `template` → its lowercase
  form. Sui's one-time-witness rule is that the struct name is the module name
  uppercased, so these two always move together.
- **constants** decimals, supply, symbol, name, description, icon URL.

`update_constants` matches on the existing bytes, so the placeholder values in
this file are load-bearing — change one here and you must change its twin in
`TPL_DEFAULTS`. `DESCRIPTION_PLACEHOLDER` and `ICON_PLACEHOLDER` are deliberately
distinct non-empty strings: two identical constants get deduplicated into one
entry by the compiler, and patching that entry would then change both fields.

## Why it mints in `init`

`launch_instadex` consumes the `TreasuryCap` into an `InstadexMintLock` and no
mint is possible afterwards. A coin that has not minted before it launches can
never mint at all, so the whole supply is minted here and sent to the creator,
who seeds it into the pair.

## Why metadata is frozen

`launch_instadex` only reads `&CoinMetadata<T>`, and a mutable metadata object
lets whoever holds it rename or re-symbol a live token — impersonation cover.
The cost is that the icon cannot be fixed later, which is why the launch page
refuses to publish when the art upload failed rather than silently going without.

## Rebuilding

    sui move build --path .
    # then base64 the module and replace COIN_TEMPLATE_B64 in index.html
    python3 -c "import base64;print(base64.b64encode(open('build/template/bytecode_modules/template.mv','rb').read()).decode())"

`create_currency` is deprecated in favour of `coin_registry`, but the deployed
arena package takes a classic `&CoinMetadata<T>`, which the registry does not
produce. It stays until the contract moves.
