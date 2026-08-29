export async function GET() {
  const r = await fetch(
    "https://api.dexpaprika.com/networks/sui/pools/0xe80e81a24dc18b5ce708bea23dc151385df291767db4b1cccb4517105f35aa17",
    { cache: "no-store" }
  );
  if (!r.ok) return Response.json({ error: "hop unavailable" }, { status: 502 });
  const d = await r.json();
  const suiPerXaum = Number(d.last_price);
  if (!(suiPerXaum > 0)) return Response.json({ error: "no price" }, { status: 502 });
  return Response.json({
    suiPerXaum,
    usd: Number(d.last_price_usd) || null,
    source: "Bluefin XAUM/SUI"
  });
}
