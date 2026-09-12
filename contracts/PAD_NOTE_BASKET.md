# Pad note — Create UI (v2 basket)

When Create is **not** on single-quote v1 holder-yield, add:

**Basket rewards:** pick which RWAs holders earn (**XAUM · XAGM · USDY**),
equal weight or custom bps, and payout mode (all-at-once or rotating).
Pair quote can stay **SUI** (or another non-basket quote). The Instant pit-bps
fee slice funds the basket instead of the Fight Night pit.

Do **not** show the basket picker on the v1 “quote *is* the RWA” path — modes
are mutually exclusive with `holder_yield` (`BasketYieldKey` vs `HolderYieldKey`).

### Create entrypoints

- `launch_instant_basket_yield_entry` / `_2_entry` / `_3_entry` — Instant + basket DF
- Collect: `collect_instadex_fees_basket_yield` (vault, **no** Pit)
- Convert PTB: `take_quote_for_convert` → (off-module swap) →
  `deposit_converted_asset` per leg (`quote_share_for_index` for event amounts)
- Claim: `claim_all` / `claim_asset` (all-at-once) or `claim_rotating`
- Sync: `basket_yield::sync_registration`

Rewards tab: index `BasketYieldLaunch/Funded/Converted/Claim/Rotate` alongside
`HolderYield*`. Status: **wired in repo, awaiting Compatible upgrade** (do not
treat as mainnet-live until published-at moves).
