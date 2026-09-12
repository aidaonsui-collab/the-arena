# Pad note — Create UI (v2 basket)

When Create is **not** on single-quote v1 holder-yield, add:

**Basket rewards:** pick which RWAs holders earn (**XAUM · XAGM · USDY**),
equal weight or custom bps, and payout mode (all-at-once now; rotating later).
Pair quote can stay **SUI** (or another non-basket quote). The Instant pit-bps
fee slice funds the basket instead of the Fight Night pit.

Do **not** show the basket picker on the v1 “quote *is* the RWA” path — modes
are mutually exclusive with `holder_yield`.

Rewards tab: index `BasketYieldLaunch/Funded/Converted/Claim/Rotate` alongside
existing `HolderYield*` events (see `BASKET_YIELD.md`). Wiring ships in a later
Compatible upgrade; this repo scaffold is design + Move stubs only.
