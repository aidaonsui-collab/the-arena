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

## Testnet proof (2026-08-30)

The patched bytecode was published to testnet to prove it passes the Move
verifier on a real network, not just that it deserialises. Built by the same
`buildCoinModule` the browser calls, signed through `sui keytool sign` so the
key stayed in the keystore, submitted with `sui client execute-signed-tx`.

- Digest: `EErb4rFYqxE7UdMHR6w3HnBG1rSQu72PKbweuYD5GWCe`
- Package: `0x87f00659ed43166fc7811a808d1297a90d5d64d370c434e5c1b27571d8db1bb1`
- Inputs: ticker `ARNTEST`, name `Arena Template Test`, 6 decimals, 1,000,000 supply

Created exactly what `launch_instadex` needs, and nothing stray:

| Object | Result |
| --- | --- |
| `Coin<ARNTEST>` | 1000000000000 = 1,000,000 at 6dp, to the sender |
| `TreasuryCap<ARNTEST>` | to the sender, ready to be consumed by the launch |
| `CoinMetadata<ARNTEST>` | owner `Immutable` — the freeze works |
| `UpgradeCap` | to the sender |

On-chain metadata read back as `name: Arena Template Test`, `symbol: ARNTEST`,
`decimals: 6`, plus the description and icon URL — every patched constant
survived the round trip.

Cost was ~0.0169 SUI (1M computation + 16.9M storage − 0.98M rebate), so a
mainnet publish is roughly two cents of gas.

One thing the run confirmed: `objectChanges` reported the gas coin as a
`mutated 0x2::coin::Coin<0x2::sui::SUI>`. `readPublishResult` filters to created
objects parameterised by the new package precisely so that coin is not mistaken
for the minted supply — this was a real hazard, not a theoretical one.

**Still unproven:** a mainnet publish, and the second transaction that seeds the
Bluefin pair. The launch call takes a 1 SUI fee and locks the position forever,
so it wants a funded throwaway wallet rather than the platform admin key.
