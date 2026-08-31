const SUI_USD =
  "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd";
const USDY_USDC =
  "https://api.dexpaprika.com/networks/sui/pools/0xdcd762ad374686fa890fc4f3b9bbfe2a244e713d7bffbfbd1b9221cb290da2ed";
const XAGM_USDC =
  "https://api.dexpaprika.com/networks/sui/pools/0x4d3cc875e334440ad3485d4455d7ee072ea01b18c526ad64f9ebe2aa0a4f01b9";
const XAUM_SUI =
  "https://api.dexpaprika.com/networks/sui/pools/0xe80e81a24dc18b5ce708bea23dc151385df291767db4b1cccb4517105f35aa17";

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

export async function GET() {
  const [usdy, xagm, xaum, suiRes] = await Promise.all([
    poolJson(USDY_USDC),
    poolJson(XAGM_USDC),
    poolJson(XAUM_SUI),
    fetch(SUI_USD, { cache: "no-store" }).catch(function () { return null; })
  ]);
  let suiUsd = 0;
  if (suiRes && suiRes.ok) {
    try {
      const g = await suiRes.json();
      suiUsd = num(g && g.sui && g.sui.usd);
    } catch (e) {}
  }
  const usdyUsd = num(usdy && (usdy.last_price_usd || usdy.last_price));
  const xagmUsd = num(xagm && (xagm.last_price_usd || xagm.last_price));
  const xaumUsd = num(xaum && xaum.last_price_usd);
  const suiPerXaum = num(xaum && xaum.last_price);
  if (!(suiUsd > 0) && xaumUsd > 0 && suiPerXaum > 0) suiUsd = xaumUsd / suiPerXaum;
  if (!(usdyUsd > 0) && !(xagmUsd > 0) && !(suiUsd > 0)) {
    return Response.json({ error: "hop unavailable" }, { status: 502 });
  }
  return Response.json({
    suiUsd,
    usdyUsd,
    xagmUsd,
    xaumUsd,
    usd: usdyUsd || xagmUsd || xaumUsd,
    suiPerXaum,
    suiPerUsdy: perSui(usdyUsd, suiUsd),
    suiPerXagm: perSui(xagmUsd, suiUsd),
    source: "Cetus USDY/USDC · Bluefin XAGM/USDC · CoinGecko SUI"
  });
}
