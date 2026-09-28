import { put } from "@vercel/blob";
import { readJsonBlob, rememberJsonBlob } from "./_blob-json.js";
import { keeperAuthOk } from "./_keeper-auth.js";

const HOP_BLOB = "hop.json";
const HOP_FRESH_MS = 10 * 60 * 1000;
const HOP_CACHE = "public, s-maxage=60, stale-while-revalidate=180";

const SUI_USD =
  "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd";
// DexPaprika keyless quota is frequently exhausted (HTTP 402). Prefer Dexscreener
// for the same Bluefin/Cetus pools; keep Paprika as a secondary source.
const SUI_USDC_POOL = "0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab";
const USDY_USDC_POOL = "0xdcd762ad374686fa890fc4f3b9bbfe2a244e713d7bffbfbd1b9221cb290da2ed";
const XAGM_USDC_POOL = "0x4d3cc875e334440ad3485d4455d7ee072ea01b18c526ad64f9ebe2aa0a4f01b9";
const XAUM_USDC_POOL = "0x458fc3722cc88babd7cbe78273aa5e4ecbdff75c76a2ad14cd1f75418b569649";
const PAPRIKA = (id) => "https://api.dexpaprika.com/networks/sui/pools/" + id;
const DEXSCREENER = (id) => "https://api.dexscreener.com/latest/dex/pairs/sui/" + id;
const VICEFUN_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0xcae6fe00841fbccb44fbe8128a7c4b2e8800e87c7952af8444d24d0e76eb31c5";
const AXOL_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0xde265ef8645c680c71b33805de77ce5261a20c58397d83b3915bdbb3a7209d7e";
const LOFI_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0xd6147f5f50e2f9f593557e497c9ee0f2387652e2a4ad73ee28bd0bdef5e3f51d";
const MANIFEST_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0x15a1adef56e1b716c29a6ce7df539fd7b8080da283199c92c6caa6f641a61c3f";
const WAL_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0xe60bc7ade245b9f35b49686dfab0a18e5ca9176d49bef1b90f60d67d06315ff0";
const DEEP_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2";
const NS_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0x763f63cbada3a932c46972c6c6dcf1abd8a9a73331908a1d7ef24c2232d85520";
const SCA_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0x9661cca01a5b9b3536883568fa967a2943e237de11a97976795f5adb293892e9";
const BLUE_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0xde705d4f3ded922b729d9b923be08e1391dd4caeff8496326123934d0fb1c312";
const ZUK_SUI_DEXSCREENER =
  "https://api.dexscreener.com/latest/dex/pairs/sui/0x43067514317fe6cffb22419a0935aae6aa6e5e5bce31e32fcfb34bd80113d2ad";

async function poolJson(url) {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return r.json();
  } catch {
    return null;
  }
}

function num(v) {
  const n = Number(v);
  return n > 0 ? n : 0;
}

function perSui(usd, suiUsd) {
  return usd > 0 && suiUsd > 0 ? usd / suiUsd : 0;
}

function paprikaUsd(j) {
  return num(j && (j.last_price_usd || j.last_price));
}

function dsUsd(j) {
  const p = j && j.pairs && j.pairs[0];
  return { usd: num(p && p.priceUsd), native: num(p && p.priceNative) };
}

function pickUsd(...vals) {
  for (const v of vals) if (num(v) > 0) return num(v);
  return 0;
}

function hasRwa(row) {
  return Number(row && row.xaumUsd) > 0 || Number(row && row.xagmUsd) > 0 || Number(row && row.usdyUsd) > 0;
}

async function liveHop() {
  const [
    usdyPap, xagmPap, xaumPap, suiPap, suiRes,
    usdyDs, xagmDs, xaumDs, suiDs,
    vicefunPair, axolPair, lofiPair, manifestPair, walPair, deepPair, nsPair, scaPair, bluePair, zukPair
  ] = await Promise.all([
    poolJson(PAPRIKA(USDY_USDC_POOL)),
    poolJson(PAPRIKA(XAGM_USDC_POOL)),
    poolJson(PAPRIKA(XAUM_USDC_POOL)),
    poolJson(PAPRIKA(SUI_USDC_POOL)),
    fetch(SUI_USD, { cache: "no-store" }).catch(function () { return null; }),
    poolJson(DEXSCREENER(USDY_USDC_POOL)),
    poolJson(DEXSCREENER(XAGM_USDC_POOL)),
    poolJson(DEXSCREENER(XAUM_USDC_POOL)),
    poolJson(DEXSCREENER(SUI_USDC_POOL)),
    poolJson(VICEFUN_SUI_DEXSCREENER),
    poolJson(AXOL_SUI_DEXSCREENER),
    poolJson(LOFI_SUI_DEXSCREENER),
    poolJson(MANIFEST_SUI_DEXSCREENER),
    poolJson(WAL_SUI_DEXSCREENER),
    poolJson(DEEP_SUI_DEXSCREENER),
    poolJson(NS_SUI_DEXSCREENER),
    poolJson(SCA_SUI_DEXSCREENER),
    poolJson(BLUE_SUI_DEXSCREENER),
    poolJson(ZUK_SUI_DEXSCREENER)
  ]);
  let suiUsd = pickUsd(paprikaUsd(suiPap), dsUsd(suiDs).usd);
  if (!(suiUsd > 0) && suiRes && suiRes.ok) {
    try {
      const g = await suiRes.json();
      suiUsd = num(g && g.sui && g.sui.usd);
    } catch (e) {}
  }
  const legs = await fillRwaPrices({
    suiUsd,
    usdyUsd: pickUsd(paprikaUsd(usdyPap), dsUsd(usdyDs).usd),
    xagmUsd: pickUsd(paprikaUsd(xagmPap), dsUsd(xagmDs).usd),
    xaumUsd: pickUsd(paprikaUsd(xaumPap), dsUsd(xaumDs).usd),
  });
  suiUsd = legs.suiUsd;
  const usdyUsd = legs.usdyUsd;
  const xagmUsd = legs.xagmUsd;
  const xaumUsd = legs.xaumUsd;
  const suiPerXaum = perSui(xaumUsd, suiUsd);
  const vicefunPairData = vicefunPair && vicefunPair.pairs && vicefunPair.pairs[0];
  let vicefunUsd = num(vicefunPairData && vicefunPairData.priceUsd);
  let suiPerVicefun = num(vicefunPairData && vicefunPairData.priceNative);
  if (!(suiPerVicefun > 0) && vicefunUsd > 0 && suiUsd > 0) suiPerVicefun = vicefunUsd / suiUsd;
  if (!(vicefunUsd > 0) && suiPerVicefun > 0 && suiUsd > 0) vicefunUsd = suiPerVicefun * suiUsd;
  const axol = dsUsd(axolPair);
  const lofi = dsUsd(lofiPair);
  const manifest = dsUsd(manifestPair);
  const wal = dsUsd(walPair);
  const deep = dsUsd(deepPair);
  const ns = dsUsd(nsPair);
  const sca = dsUsd(scaPair);
  const blue = dsUsd(bluePair);
  const zuk = dsUsd(zukPair);
  if (!(usdyUsd > 0) && !(xagmUsd > 0) && !(xaumUsd > 0) && !(suiUsd > 0)) {
    return null;
  }
  return {
    suiUsd,
    usdyUsd,
    xagmUsd,
    xaumUsd,
    vicefunUsd,
    axolUsd: axol.usd,
    lofiUsd: lofi.usd,
    manifestUsd: manifest.usd,
    walUsd: wal.usd,
    deepUsd: deep.usd,
    nsUsd: ns.usd,
    scaUsd: sca.usd,
    blueUsd: blue.usd,
    zukUsd: zuk.usd,
    usd: xaumUsd || usdyUsd || xagmUsd,
    suiPerXaum,
    suiPerUsdy: perSui(usdyUsd, suiUsd),
    suiPerXagm: perSui(xagmUsd, suiUsd),
    suiPerVicefun,
    suiPerAxol: axol.native || perSui(axol.usd, suiUsd),
    suiPerLofi: lofi.native || perSui(lofi.usd, suiUsd),
    suiPerManifest: manifest.native || perSui(manifest.usd, suiUsd),
    suiPerZuk: zuk.native || perSui(zuk.usd, suiUsd),
    source: "Dexscreener + DexPaprika",
    updatedMs: Date.now(),
  };
}

const GQL = "https://graphql.mainnet.sui.io/graphql";
const Q64 = 2 ** 64;
// Pool legs: [field, poolId, coin decimals, USDC is coin A?]. All four pools pair with native USDC (6 decimals).
const ONCHAIN_LEGS = [
  ["xaumUsd", XAUM_USDC_POOL, 9, false],
  ["xagmUsd", XAGM_USDC_POOL, 9, false],
  ["usdyUsd", USDY_USDC_POOL, 6, true],
  ["suiUsd", SUI_USDC_POOL, 9, true],
];

/** USD price straight from each pool's current_sqrt_price over Sui GraphQL. */
async function onchainUsd(fields) {
  const legs = ONCHAIN_LEGS.filter(function (l) { return fields.indexOf(l[0]) >= 0; });
  if (!legs.length) return {};
  const query = "{" + legs.map(function (l, i) {
    return "p" + i + ": object(address:\"" + l[1] + "\"){ asMoveObject { contents { json } } }";
  }).join(" ") + "}";
  let data = null;
  try {
    const r = await fetch(GQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query }),
      cache: "no-store",
    });
    if (r.ok) data = (await r.json()).data;
  } catch {}
  const out = {};
  if (!data) return out;
  legs.forEach(function (l, i) {
    const j = data["p" + i] && data["p" + i].asMoveObject && data["p" + i].asMoveObject.contents && data["p" + i].asMoveObject.contents.json;
    const sq = Number(j && j.current_sqrt_price);
    if (!(sq > 0)) return;
    const raw = (sq / Q64) * (sq / Q64); // coin B per coin A, base units
    let px;
    if (l[3]) {
      // A = USDC (6), B = asset: asset per USDC = raw * 10^(6-dec)
      const assetPerUsdc = raw * Math.pow(10, 6 - l[2]);
      px = assetPerUsdc > 0 ? 1 / assetPerUsdc : 0;
    } else {
      // A = asset, B = USDC (6): USDC per asset = raw * 10^(dec-6)
      px = raw * Math.pow(10, l[2] - 6);
    }
    if (px > 0 && isFinite(px)) out[l[0]] = px;
  });
  return out;
}

/** Fill any missing SUI/RWA leg: on-chain pool price first, then Dexscreener. */
async function fillRwaPrices(row) {
  const fields = ["usdyUsd", "xagmUsd", "xaumUsd", "suiUsd"];
  let missing = fields.filter(function (k) { return !(Number(row[k]) > 0); });
  if (!missing.length) return row;
  const chain = await onchainUsd(missing);
  missing.forEach(function (k) { if (chain[k] > 0) row[k] = chain[k]; });
  missing = missing.filter(function (k) { return !(Number(row[k]) > 0); });
  if (!missing.length) return row;
  const pools = { usdyUsd: USDY_USDC_POOL, xagmUsd: XAGM_USDC_POOL, xaumUsd: XAUM_USDC_POOL, suiUsd: SUI_USDC_POOL };
  const got = await Promise.all(missing.map(function (k) { return poolJson(DEXSCREENER(pools[k])); }));
  missing.forEach(function (k, i) {
    const px = dsUsd(got[i]).usd;
    if (px > 0) row[k] = px;
  });
  return row;
}

function deriveHop(row) {
  const sui = Number(row.suiUsd) || 0;
  if (!(Number(row.suiPerXaum) > 0)) row.suiPerXaum = perSui(Number(row.xaumUsd), sui);
  if (!(Number(row.suiPerUsdy) > 0)) row.suiPerUsdy = perSui(Number(row.usdyUsd), sui);
  if (!(Number(row.suiPerXagm) > 0)) row.suiPerXagm = perSui(Number(row.xagmUsd), sui);
  if (!(Number(row.usd) > 0)) row.usd = num(row.xaumUsd) || num(row.usdyUsd) || num(row.xagmUsd);
  return row;
}

function mergeHop(prev, next) {
  const out = Object.assign({}, prev || {}, next || {});
  // Never let a failed Paprika tick wipe known-good RWA/SUI prices.
  ["suiUsd", "usdyUsd", "xagmUsd", "xaumUsd", "usd",
    "suiPerXaum", "suiPerUsdy", "suiPerXagm", "suiPerVicefun",
    "vicefunUsd", "axolUsd", "lofiUsd", "manifestUsd",
    "walUsd", "deepUsd", "nsUsd", "scaUsd", "blueUsd", "zukUsd",
    "suiPerAxol", "suiPerLofi", "suiPerManifest", "suiPerZuk"].forEach(function (k) {
    if (!(Number(out[k]) > 0) && Number(prev && prev[k]) > 0) out[k] = prev[k];
  });
  return out;
}

async function storeHop(row) {
  await put(HOP_BLOB, JSON.stringify(row), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 30,
  });
  rememberJsonBlob(HOP_BLOB, row);
}

export async function GET() {
  const cached = await readJsonBlob(HOP_BLOB, null);
  const fresh = cached && Number(cached.suiUsd) > 0 && hasRwa(cached)
    && Date.now() - Number(cached.updatedMs || 0) < HOP_FRESH_MS;
  if (fresh) {
    return Response.json(cached, { headers: { "cache-control": HOP_CACHE } });
  }
  const live = await liveHop();
  if (!live) {
    if (cached && Number(cached.suiUsd) > 0) {
      return Response.json(cached, { headers: { "cache-control": HOP_CACHE } });
    }
    return Response.json({ error: "hop unavailable" }, { status: 502 });
  }
  const row = mergeHop(cached, deriveHop(live));
  try { await storeHop(row); } catch (e) {}
  return Response.json(row, { headers: { "cache-control": HOP_CACHE } });
}

export async function POST(request) {
  if (!keeperAuthOk(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  if (!(Number(body && body.suiUsd) > 0)) {
    return Response.json({ error: "suiUsd required" }, { status: 400 });
  }
  const cached = await readJsonBlob(HOP_BLOB, null);
  // The Air keeper reads RWA prices from DexPaprika. When that quota runs out it
  // posts zeros; fill those legs from the pools on-chain (or Dexscreener) first.
  const incoming = deriveHop(await fillRwaPrices(Object.assign({}, body)));
  const row = mergeHop(cached, Object.assign(incoming, {
    updatedMs: Date.now(),
    source: body.source || "Air",
  }));
  try {
    await storeHop(row);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return Response.json({ error: why.slice(0, 180) }, { status: 502 });
  }
  return Response.json({ ok: true, updatedMs: row.updatedMs });
}
