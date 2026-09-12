# Vice

Fair launches on Sui. **Instadex Instant** seeds Bluefin in block one on SUI, USDY (Ondo T-bills), XAGM (Matrixdock silver), or XAUM (Matrixdock gold): 100% of the token, 0 real quote, 1 SUI launch fee. First-buy hops: Cetus USDY/USDC for T-bills, Bluefin XAGM/USDC and XAUM/USDC for silver and gold. LP is locked forever.

**Fees.** Bluefin pair fee is 1% (protocol keeps 20%). Of the remaining quote LP share, default Instant is **60/10/30 creator / platform / pot**. Instant **holder-yield** (v11+) routes that 30% into a claimable vault of the **paired RWA** for registered holders instead of the pot — see [`contracts/HOLDER_YIELD.md`](contracts/HOLDER_YIELD.md). Instant **basket-yield** (v12+) stages quote then converts into a multi-asset basket — see [`contracts/BASKET_YIELD.md`](contracts/BASKET_YIELD.md). Curve fills still use 60/10/30 (or reflection 50/20/20/10). Token-side LP fees burn.

**Rewards.** The old Pit nav is now **Rewards** (`#/pit`): gold / silver / T-bills (XAUM / XAGM / USDY) distributions from holder-yield launches. Multi-RWA baskets (pair one quote, pay several RWAs) are the next scaffold after v1 single-quote yield.

Curve launches and Fight Night still exist on-chain. Graduation at 2,000 SUI (or 1 XAUM for leftover gold). Stock wraps (RH→Sui) live under [`contracts-stocks/`](contracts-stocks/) + Bridge.

Vanilla HTML/CSS/JS SPA (`index.html`). Hash routes: `#/` Explore, `#/pit` Rewards, `#/metrics` Books, `#/bridge` Bridge, `#/launch` Create, `#/token/TICKER`. Token page embeds Dexscreener for Bluefin pools.

## Contracts

Sui Move package: [`contracts/`](contracts/). Instant Create quotes: TOKEN/SUI, TOKEN/USDY, TOKEN/XAGM, TOKEN/XAUM.

- Type origin: `0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`
- Latest published-at (**v12**): `0x1710adbe0293015cac7492b6db0cf871a7af81c5a51cd9d5d99d3aadf9fea161` (basket-yield Instant; holder-yield from v11)
- Config: `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`
- Pit SUI: `0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`
- Pit XAUM: `0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783`
- Pit USDY/XAGM: `create_pit` + AdminCap `register_pit` if not already bound

Call new functions on the latest published-at; object types stay on the type origin. Full version history: [`contracts/PUBLISHED.md`](contracts/PUBLISHED.md).

Platform treasury (1 SUI launch fee + the 10% platform cut) withdraws with `AdminCap`, held by `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.

At graduation the production path (`lock::seed_and_lock_bluefin` / `_with_fee`) seeds Bluefin Spot and time-locks the Position NFT. Instant locks are permanent (`unlock_ms = 0`).

## Keepers

Cron jobs (pit bell / settle, Instadex collect, reflection index) live in [`keepers/`](keepers/). Collect defaults to CALL package **v12**.

## Token art (Vercel Blob)

Store `arena-art` is linked to this project. Create POSTs the image bytes to `/api/upload` with `Content-Type: image/png` (or jpeg/webp/gif) and optional `x-filename`. Response `{ url }` is the public HTTPS URL for the card.

```
Upload requires a wallet signature of `arena-upload:<unix-ms>` (fresh within 10 minutes), plus 8/hour quota. Bytes are sniffed (png/jpeg/webp/gif), not trusted from `Content-Type`.

```
const ts = Date.now();
const { signature } = await wallet.signPersonalMessage({ message: new TextEncoder().encode("arena-upload:" + ts) });
const res = await fetch('/api/upload', {
  method: 'POST',
  headers: {
    'content-type': file.type,
    'x-filename': file.name,
    'x-sui-address': address,
    'x-sui-signature': signature,
    'x-sui-ts': String(ts),
  },
  body: file,
});
const { url } = await res.json();
```
```
