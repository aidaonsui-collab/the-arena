import { put } from "@vercel/blob";
import { readJsonBlob, rememberJsonBlob } from "./_blob-json.js";
import { keeperAuthOk } from "./_keeper-auth.js";

const HOP_BLOB = "hop.json";
const HOP_FRESH_MS = 10 * 60 * 1000;
const HOP_CACHE = "public, s-maxage=60, stale-while-revalidate=180";

const SUI_USD =
  "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd";
const SUI_USDC =
  "https://api.dexpaprika.com/networks/sui/pools/0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab";
const USDY_USDC =
  "https://api.dexpaprika.com/networks/sui/pools/0xdcd762ad374686fa890fc4f3b9bbfe2a244e713d7bffbfbd1b9221cb290da2ed";
const XAGM_USDC =
  "https://api.dexpaprika.com/networks/sui/pools/0x4d3cc875e334440ad3485d4455d7ee072ea01b18c526ad64f9ebe2aa0a4f01b9";
const XAUM_USDC =
  "https://api.dexpaprika.com/networks/sui/pools/0x458fc3722cc88babd7cbe78273aa5e4ecbdff75c76a2ad14cd1f75418b569649";
// VICEFUN/SUI isn't indexed on DexPaprika (low-volume, community pool) — Dexscreener has it,
// and hands back priceUsd/priceNative directly so no on-chain sqrt-price decoding is needed.
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

async function poolJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  return r.json();
}

function num(v) {
  const n = Number(v);
  return n > 0 ? n : 0;
}

function perSui(usd, suiUsd) {
  return usd > 0 && suiUsd > 0 ? usd / suiUsd : 0;
}

async function liveHop() {
  const [usdy, xagm, xaum, suiUsdc, suiRes, vicefunPair, axolPair, lofiPair, manifestPair, walPair, deepPair, nsPair, scaPair, bluePair] = await Promise.all([
    poolJson(USDY_USDC),
    poolJson(XAGM_USDC),
    poolJson(XAUM_USDC),
    poolJson(SUI_USDC),
    fetch(SUI_USD, { cache: "no-store" }).catch(function () { return null; }),
    poolJson(VICEFUN_SUI_DEXSCREENER),
    poolJson(AXOL_SUI_DEXSCREENER),
    poolJson(LOFI_SUI_DEXSCREENER),
    poolJson(MANIFEST_SUI_DEXSCREENER),
    poolJson(WAL_SUI_DEXSCREENER),
    poolJson(DEEP_SUI_DEXSCREENER),
    poolJson(NS_SUI_DEXSCREENER),
    poolJson(SCA_SUI_DEXSCREENER),
    poolJson(BLUE_SUI_DEXSCREENER)
  ]);
  let suiUsd = num(suiUsdc && (suiUsdc.last_price_usd || suiUsdc.last_price));
  if (!(suiUsd > 0) && suiRes && suiRes.ok) {
    try {
      const g = await suiRes.json();
      suiUsd = num(g && g.sui && g.sui.usd);
    } catch (e) {}
  }
  const usdyUsd = num(usdy && (usdy.last_price_usd || usdy.last_price));
  const xagmUsd = num(xagm && (xagm.last_price_usd || xagm.last_price));
  const xaumUsd = num(xaum && (xaum.last_price_usd || xaum.last_price));
  const suiPerXaum = perSui(xaumUsd, suiUsd);
  const vicefunPairData = vicefunPair && vicefunPair.pairs && vicefunPair.pairs[0];
  let vicefunUsd = num(vicefunPairData && vicefunPairData.priceUsd);
  let suiPerVicefun = num(vicefunPairData && vicefunPairData.priceNative);
  if (!(suiPerVicefun > 0) && vicefunUsd > 0 && suiUsd > 0) suiPerVicefun = vicefunUsd / suiUsd;
  if (!(vicefunUsd > 0) && suiPerVicefun > 0 && suiUsd > 0) vicefunUsd = suiPerVicefun * suiUsd;
  function dsUsd(j) {
    const p = j && j.pairs && j.pairs[0];
    return { usd: num(p && p.priceUsd), native: num(p && p.priceNative) };
  }
  const axol = dsUsd(axolPair);
  const lofi = dsUsd(lofiPair);
  const manifest = dsUsd(manifestPair);
  const wal = dsUsd(walPair);
  const deep = dsUsd(deepPair);
  const ns = dsUsd(nsPair);
  const sca = dsUsd(scaPair);
  const blue = dsUsd(bluePair);
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
    usd: xaumUsd || usdyUsd || xagmUsd,
    suiPerXaum,
    suiPerUsdy: perSui(usdyUsd, suiUsd),
    suiPerXagm: perSui(xagmUsd, suiUsd),
    suiPerVicefun,
    suiPerAxol: axol.native || perSui(axol.usd, suiUsd),
    suiPerLofi: lofi.native || perSui(lofi.usd, suiUsd),
    suiPerManifest: manifest.native || perSui(manifest.usd, suiUsd),
    source: "Air · Dexscreener + DexPaprika",
    updatedMs: Date.now(),
  };
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
  if (cached && Number(cached.suiUsd) > 0 && Date.now() - Number(cached.updatedMs || 0) < HOP_FRESH_MS) {
    return Response.json(cached, { headers: { "cache-control": HOP_CACHE } });
  }
  const live = await liveHop();
  if (!live) return Response.json({ error: "hop unavailable" }, { status: 502 });
  try { await storeHop(live); } catch (e) {}
  return Response.json(live, { headers: { "cache-control": HOP_CACHE } });
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
  const row = Object.assign({}, body, { updatedMs: Date.now(), source: body.source || "Air" });
  try {
    await storeHop(row);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return Response.json({ error: why.slice(0, 180) }, { status: 502 });
  }
  return Response.json({ ok: true, updatedMs: row.updatedMs });
}
