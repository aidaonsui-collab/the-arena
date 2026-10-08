// Bluefin's pool list has no browser CORS header. The page asks this route,
// then checks the pool object on Sui before it will swap.
const BLUEFIN = "https://swap.api.sui-prod.bluefin.io/api/v1/pools/info";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const SUI = "0x2::sui::SUI";

function normType(t) {
  const parts = String(t || "").trim().split("::");
  if (parts.length < 3) return "";
  const addr = parts[0].replace(/^0x/i, "").replace(/^0+/, "") || "0";
  parts[0] = "0x" + addr.toLowerCase();
  return parts.join("::");
}

function side(token) {
  if (!token) return "";
  const info = token.info || token;
  return normType(info.address || "");
}

export function filterBluefinPools(rows, coin) {
  const want = normType(coin);
  const usdc = normType(USDC);
  const sui = normType(SUI);
  const out = [];
  for (const row of rows || []) {
    if (!row || row.is_paused || !row.address) continue;
    const a = side(row.tokenA);
    const b = side(row.tokenB);
    let quote = "";
    let quoteAmt = "0";
    if (a === want && b === usdc) { quote = "USDC"; quoteAmt = String(row.tokenB && row.tokenB.amount || "0"); }
    else if (b === want && a === usdc) { quote = "USDC"; quoteAmt = String(row.tokenA && row.tokenA.amount || "0"); }
    else if (a === want && b === sui) { quote = "SUI"; quoteAmt = String(row.tokenB && row.tokenB.amount || "0"); }
    else if (b === want && a === sui) { quote = "SUI"; quoteAmt = String(row.tokenA && row.tokenA.amount || "0"); }
    else continue;
    out.push({ id: row.address, quote, quoteAmt });
  }
  out.sort((a, b) => {
    try {
      const av = BigInt(a.quoteAmt);
      const bv = BigInt(b.quoteAmt);
      if (av === bv) return 0;
      return av > bv ? -1 : 1;
    } catch { return 0; }
  });
  return out.slice(0, 12);
}

export async function GET(request) {
  const coin = new URL(request.url).searchParams.get("coin") || "";
  if (!normType(coin)) return Response.json({ error: "coin type required" }, { status: 400 });
  const res = await fetch(BLUEFIN + "?token=" + encodeURIComponent(normType(coin)));
  if (!res.ok) return Response.json({ error: "Bluefin pool list failed" }, { status: 502 });
  const rows = await res.json();
  if (!Array.isArray(rows)) return Response.json({ error: "Bluefin pool list failed" }, { status: 502 });
  return Response.json({ pools: filterBluefinPools(rows, coin) }, {
    headers: { "cache-control": "public, max-age=30" }
  });
}
