# The Arena

Fair launches on Sui. Bonding curves, no presale. Graduation at 2,000 SUI (or 1 XAUM for gold). 1% swap fee on every fill, split 60/10/30 creator/platform/pit (reflection: 50/20/20/10 reflections/creator/pit/platform).

Vanilla HTML/CSS/JS SPA (`index.html`). Hash routes: `#/` Explore, `#/pit`, `#/launch`, `#/token/VOLT`. Token page mounts TradingView Advanced on `#tv-host` from static OHLC via `ArenaIndex.toCandles`.

## Contracts

Sui Move package for the launchpad lives in [`contracts/`](contracts/). TOKEN/SUI, TOKEN/XAUM (Bluefin gold ticker), and reflection launches.

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
