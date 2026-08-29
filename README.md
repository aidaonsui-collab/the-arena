# The Arena

Fair launches on Sui. Bonding curves, no presale. Graduation at 2,000 SUI (or 1 XAUM for gold). 1% swap fee on every fill, split 60/10/30 creator/platform/pit (reflection: 50/20/20/10 reflections/creator/pit/platform).

Vanilla HTML/CSS/JS SPA (`index.html`). Hash routes: `#/` Explore, `#/pit`, `#/launch`, `#/token/VOLT`. Token page mounts TradingView Advanced on `#tv-host` from static OHLC via `ArenaIndex.toCandles`.

## Contracts

Sui Move package for the launchpad lives in [`contracts/`](contracts/). TOKEN/SUI, TOKEN/XAUM (Bluefin gold ticker), and reflection launches. Mainnet package `0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea`. Shared Config `0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c`, Pit SUI `0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c`, Pit XAUM `0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783`.

Platform treasury (1 SUI launch fee + the 10% platform cut of swap fees) withdraws with `AdminCap`. That cap is sent at publish to the same wallet The Odyssey on Sui uses: `0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b`.

## Keepers

Cron jobs (pit bell, pit settle, reflection index) live in [`keepers/`](keepers/).

## Token art (Vercel Blob)

Store `arena-art` is linked to this project. Create POSTs the image bytes to `/api/upload` with `Content-Type: image/png` (or jpeg/webp/gif) and optional `x-filename`. Response `{ url }` is the public HTTPS URL for the card.

```
const res = await fetch('/api/upload', {
  method: 'POST',
  headers: { 'content-type': file.type, 'x-filename': file.name },
  body: file,
});
const { url } = await res.json();
```
