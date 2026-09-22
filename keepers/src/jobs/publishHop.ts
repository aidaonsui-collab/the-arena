/**
 * Refresh quote USD prices on Jessica's Air and POST them to /api/hop.
 * The site then serves that blob instead of fan-out on every page load.
 */
import { APP_URL } from "../chain.ts";

const SUI_USD = "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd";
const SUI_USDC = "https://api.dexpaprika.com/networks/sui/pools/0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab";
const USDY_USDC = "https://api.dexpaprika.com/networks/sui/pools/0xdcd762ad374686fa890fc4f3b9bbfe2a244e713d7bffbfbd1b9221cb290da2ed";
const XAGM_USDC = "https://api.dexpaprika.com/networks/sui/pools/0x4d3cc875e334440ad3485d4455d7ee072ea01b18c526ad64f9ebe2aa0a4f01b9";
const XAUM_USDC = "https://api.dexpaprika.com/networks/sui/pools/0x458fc3722cc88babd7cbe78273aa5e4ecbdff75c76a2ad14cd1f75418b569649";

const PAIRS: Record<string, string> = {
  vicefun: "0xcae6fe00841fbccb44fbe8128a7c4b2e8800e87c7952af8444d24d0e76eb31c5",
  axol: "0xde265ef8645c680c71b33805de77ce5261a20c58397d83b3915bdbb3a7209d7e",
  lofi: "0xd6147f5f50e2f9f593557e497c9ee0f2387652e2a4ad73ee28bd0bdef5e3f51d",
  manifest: "0x15a1adef56e1b716c29a6ce7df539fd7b8080da283199c92c6caa6f641a61c3f",
  wal: "0xe60bc7ade245b9f35b49686dfab0a18e5ca9176d49bef1b90f60d67d06315ff0",
  deep: "0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2",
  ns: "0x763f63cbada3a932c46972c6c6dcf1abd8a9a73331908a1d7ef24c2232d85520",
  sca: "0x9661cca01a5b9b3536883568fa967a2943e237de11a97976795f5adb293892e9",
  blue: "0xde705d4f3ded922b729d9b923be08e1391dd4caeff8496326123934d0fb1c312",
};

function num(v: unknown): number {
  const n = Number(v);
  return n > 0 ? n : 0;
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function pxOf(j: Record<string, unknown> | null): number {
  if (!j) return 0;
  return num(j.last_price_usd || j.last_price);
}

function ds(j: Record<string, unknown> | null): { usd: number; native: number } {
  const pairs = (j && (j.pairs as Record<string, unknown>[])) || [];
  const p = pairs[0] || {};
  return { usd: num(p.priceUsd), native: num(p.priceNative) };
}

function perSui(usd: number, suiUsd: number): number {
  return usd > 0 && suiUsd > 0 ? usd / suiUsd : 0;
}

export async function runPublishHop() {
  const secret = process.env.ARENA_SETTLE_SECRET || process.env.CRON_SECRET || "";
  if (!secret) return { skipped: "no CRON_SECRET" };
  const dexUrls = Object.values(PAIRS).map((id) => "https://api.dexscreener.com/latest/dex/pairs/sui/" + id);
  const [usdy, xagm, xaum, suiUsdc, suiG, ...dex] = await Promise.all([
    getJson(USDY_USDC),
    getJson(XAGM_USDC),
    getJson(XAUM_USDC),
    getJson(SUI_USDC),
    getJson(SUI_USD),
    ...dexUrls.map(getJson),
  ]);
  let suiUsd = pxOf(suiUsdc);
  if (!(suiUsd > 0) && suiG) suiUsd = num((suiG.sui as { usd?: number } | undefined)?.usd);
  const usdyUsd = pxOf(usdy);
  const xagmUsd = pxOf(xagm);
  const xaumUsd = pxOf(xaum);
  const names = Object.keys(PAIRS);
  const spot: Record<string, { usd: number; native: number }> = {};
  names.forEach((name, i) => {
    spot[name] = ds(dex[i]);
  });
  const vice = spot.vicefun || { usd: 0, native: 0 };
  let vicefunUsd = vice.usd;
  let suiPerVicefun = vice.native;
  if (!(suiPerVicefun > 0) && vicefunUsd > 0 && suiUsd > 0) suiPerVicefun = vicefunUsd / suiUsd;
  if (!(vicefunUsd > 0) && suiPerVicefun > 0 && suiUsd > 0) vicefunUsd = suiPerVicefun * suiUsd;
  if (!(suiUsd > 0)) throw new Error("sui price missing");
  const body: Record<string, number | string> = {
    suiUsd,
    usdyUsd,
    xagmUsd,
    xaumUsd,
    vicefunUsd,
    axolUsd: spot.axol.usd,
    lofiUsd: spot.lofi.usd,
    manifestUsd: spot.manifest.usd,
    walUsd: spot.wal.usd,
    deepUsd: spot.deep.usd,
    nsUsd: spot.ns.usd,
    scaUsd: spot.sca.usd,
    blueUsd: spot.blue.usd,
    usd: xaumUsd || usdyUsd || xagmUsd,
    suiPerXaum: perSui(xaumUsd, suiUsd),
    suiPerUsdy: perSui(usdyUsd, suiUsd),
    suiPerXagm: perSui(xagmUsd, suiUsd),
    suiPerVicefun,
    suiPerAxol: spot.axol.native || perSui(spot.axol.usd, suiUsd),
    suiPerLofi: spot.lofi.native || perSui(spot.lofi.usd, suiUsd),
    suiPerManifest: spot.manifest.native || perSui(spot.manifest.usd, suiUsd),
    source: "Air",
  };
  const r = await fetch(`${APP_URL}/api/hop`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(raw.slice(0, 180) || `hop ${r.status}`);
  return { ok: true, suiUsd, vicefunUsd };
}
