import { readJsonBlob } from "./_blob-json.js";

/** Instant read of the index api/rewards-index.js keeps up to date. */
const BLOB_PATH = "rewards-index/vicefun.json";

function vercelHost(v) {
  if (!v) return "";
  return v.startsWith("http") ? v.replace(/\/$/, "") : `https://${v}`;
}

function originOk(request) {
  const origin = (request.headers.get("origin") || "").replace(/\/$/, "");
  if (!origin) return true;
  if (/vicefun\.com$/i.test(origin) || /the-arena|\.vercel\.app$/i.test(origin)) return true;
  const allow = (process.env.ARENA_ORIGIN || "")
    .split(",")
    .map((s) => vercelHost(s.trim()))
    .filter(Boolean);
  for (const key of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) {
    const host = vercelHost(process.env[key] || "");
    if (host) allow.push(host);
  }
  return allow.some((a) => origin === a || origin.startsWith(a + "/"));
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function json(body, status, request, extra) {
  return Response.json(body, { status, headers: Object.assign(corsHeaders(request), extra || {}) });
}

function normAddr(a) {
  a = String(a || "").trim().toLowerCase();
  if (!a) return "";
  if (!a.startsWith("0x")) a = "0x" + a;
  const hex = a.slice(2).replace(/^0+/, "") || "0";
  if (!/^[0-9a-f]+$/.test(hex)) return "";
  return "0x" + hex.padStart(64, "0");
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  const url = new URL(request.url);
  const addr = normAddr(url.searchParams.get("addr") || "");
  if (!addr) return json({ error: "addr required" }, 400, request);

  const state = await readJsonBlob(BLOB_PATH, null);
  const wallet = (state && state.wallets && state.wallets[addr]) || {};
  const parts = Object.keys(wallet).map((asset) => ({ asset, amount: wallet[asset] }));

  return json(
    { addr, parts, indexUpdatedMs: (state && state.updatedMs) || 0 },
    200,
    request,
    { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" },
  );
}
