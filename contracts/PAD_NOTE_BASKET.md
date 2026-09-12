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
`HolderYield*`. Status: **mainnet-live on v12** published-at
`0x1710adbe0293015cac7492b6db0cf871a7af81c5a51cd9d5d99d3aadf9fea161`
(upgrade `D8Ck8tVA5BRjUTPQJpHAc1pWAiHm6LaP7R8cEo3sUSGf`).

### Migrate CTA (existing plain Instant)

On the **token page**, when the connected wallet is `lock.beneficiary` and the
lock has **no** `HolderYieldKey` / `BasketYieldKey`:

| Quote | Control |
| --- | --- |
| XAUM / XAGM / USDY | **Migrate · holder yield** → `migrate_instant_to_holder_yield_entry` |
| SUI | Reuse Create **basket picker** (1–3 · equal/custom % · all-at-once/rotating) → `migrate_instant_to_basket_yield_{,_2,_3}_entry` |

After migrate, Rewards indexes the reused `*YieldLaunchEvent`, and Collect /
keepers route via vault (DF or event) — no Pit collect.

