# Vice

Fair launches on Sui. Instadex Instant seeds Bluefin in block one (SUI, USDY, or XAGM): 100% of the token, 0 real quote, 1 SUI launch fee. LP is locked forever. Curve launches still exist on-chain. Graduation at 2,000 SUI (or 1 XAUM for leftover gold). 1% swap fee on curve fills, split 60/10/30 creator/platform/pit (reflection: 50/20/20/10 reflections/creator/pit/platform). Bluefin pair fee is 1% (protocol keeps 20%); remaining quote LP share is 60/10/30; token-side LP fees burn. Leftover LOOK/XAUM Instant pairs still trade.

Vanilla HTML/CSS/JS SPA (`index.html`). Hash routes: `#/` Explore, `#/pit`, `#/launch`, `#/token/TICKER`. Token page embeds Dexscreener for Bluefin pools.

## Contracts

Sui Move package for the launchpad lives in [`contracts/`](contracts/). Instant Create quotes are TOKEN/SUI, TOKEN/USDY (Ondo T-bills), and TOKEN/XAGM (Matrixdock silver). Leftover TOKEN/XAUM still works. Mainnet package `0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`. Shared Config `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`, Pit SUI `0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`, Pit XAUM `0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783`. Pit USDY/XAGM need `create_pit` + AdminCap `register_pit`.

Platform treasury (1 SUI launch fee + the 10% platform cut of swap fees) withdraws with `AdminCap`. That cap is sent at publish to the same wallet The Odyssey on Sui uses: `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.

At graduation the production path (`lock::seed_and_lock_bluefin` / `_with_fee`) seeds a Bluefin Spot pool and time-locks the Position NFT for 180 days to the creator. PTB: Pool, Config, Clock (`0x6`), Bluefin GlobalConfig `0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352`, CoinMetadata T and Q, optional SUI creation fee when the quote is XAUM. Raw-coin vault `lock::lock_graduated_lp` remains for tests/fallback.

## Keepers

Cron jobs (pit bell, pit settle, reflection index) live in [`keepers/`](keepers/).

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
