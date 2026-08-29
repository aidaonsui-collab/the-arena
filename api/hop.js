const XAUM_SUI =
  "https://api.dexpaprika.com/networks/sui/pools/0xe80e81a24dc18b5ce708bea23dc151385df291767db4b1cccb4517105f35aa17";
const SUI_USD =
  "https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd";

export async function GET() {
  const [hopRes, suiRes] = await Promise.all([
    fetch(XAUM_SUI, { cache: "no-store" }),
    fetch(SUI_USD, { cache: "no-store" })
  ]);
  if (!hopRes.ok) return Response.json({ error: "hop unavailable" }, { status: 502 });
  const d = await hopRes.json();
  const suiPerXaum = Number(d.last_price);
  if (!(suiPerXaum > 0)) return Response.json({ error: "no price" }, { status: 502 });
  const xaumUsd = Number(d.last_price_usd) || null;
  let suiUsd = null;
  if (suiRes.ok) {
    try {
      const g = await suiRes.json();
      suiUsd = Number(g && g.sui && g.sui.usd) || null;
    } catch (e) {}
  }
  if (!(suiUsd > 0) && xaumUsd > 0) suiUsd = xaumUsd / suiPerXaum;
  return Response.json({
    suiPerXaum,
    usd: xaumUsd,
    xaumUsd,
    suiUsd,
    source: "Bluefin XAUM/SUI · CoinGecko SUI"
  });
}
