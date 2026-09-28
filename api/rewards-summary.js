import { readJsonBlob } from "./_blob-json.js";

/**
 * Public roll-up of the VICEFUN basket push index (rewards-index/vicefun.json,
 * kept current by the Air keeper). The Distributions page only walks the newest
 * push events in the browser, which undercounts wallets once there are more
 * than a few thousand pushes. This returns the full wallet count and the
 * per-asset totals pushed to holders.
 */
const BLOB_PATH = "rewards-index/vicefun.json";

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const state = await readJsonBlob(BLOB_PATH, null);
  const wallets = (state && state.wallets) || {};
  const totals = {};
  let paid = 0;
  for (const addr of Object.keys(wallets)) {
    const row = wallets[addr] || {};
    let any = false;
    for (const asset of Object.keys(row)) {
      let amt;
      try { amt = BigInt(String(row[asset] || "0")); } catch { amt = 0n; }
      if (amt <= 0n) continue;
      any = true;
      totals[asset] = String((BigInt(totals[asset] || "0") + amt));
    }
    if (any) paid++;
  }
  return Response.json(
    { wallets: paid, totals, updatedMs: (state && state.updatedMs) || 0 },
    {
      headers: Object.assign(corsHeaders(request), {
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      }),
    },
  );
}
