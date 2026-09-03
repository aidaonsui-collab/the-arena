import { put, list } from "@vercel/blob";

const TICKER_RE = /^[A-Z][A-Z0-9_.\-]{0,15}$/;

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
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type, authorization",
    vary: "Origin",
  };
}

function json(body, status, request, extra) {
  return Response.json(body, { status, headers: Object.assign(corsHeaders(request), extra || {}) });
}

function safeTicker(v) {
  const t = String(v || "").trim().toUpperCase();
  return TICKER_RE.test(t) ? t : "";
}

function blobPath(ticker) {
  return "token-stats/" + ticker + ".json";
}

function authOk(request) {
  const secret = process.env.CRON_SECRET || process.env.ARENA_SETTLE_SECRET || "";
  if (!secret) return !process.env.VERCEL;
  const raw = request.headers.get("authorization") || "";
  return raw === "Bearer " + secret;
}

async function loadStats(ticker) {
  try {
    const { blobs } = await list({ prefix: blobPath(ticker), limit: 8 });
    const path = blobPath(ticker);
    const hit =
      (blobs || []).find(function (b) {
        return b.pathname === path || String(b.pathname || "").endsWith("/" + path);
      }) || (blobs || [])[0];
    if (!hit) return null;
    const r = await fetch(hit.url, { cache: "no-store" });
    if (!r.ok) return null;
    const row = await r.json();
    if (!row || typeof row !== "object") return null;
    return row;
  } catch {
    return null;
  }
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const url = new URL(request.url);
  const ticker = safeTicker(url.searchParams.get("t") || url.searchParams.get("ticker"));
  if (!ticker) return json({ error: "ticker required" }, 400, request);
  const row = await loadStats(ticker);
  return json({ stats: row }, 200, request, { "cache-control": "no-store" });
}

export async function POST(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  if (!authOk(request)) return json({ error: "unauthorized" }, 401, request);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400, request);
  }
  const ticker = safeTicker(body && (body.ticker || body.t));
  if (!ticker) return json({ error: "ticker required" }, 400, request);
  const row = {
    ticker,
    burned: String(body.burned || "0"),
    coinA: String(body.coinA || "0"),
    coinB: String(body.coinB || "0"),
    quote: String(body.quote || "SUI"),
    pool: String(body.pool || ""),
    lock: String(body.lock || ""),
    mcUsd: Number(body.mcUsd) || 0,
    updatedMs: Date.now(),
  };
  try {
    await put(blobPath(ticker), JSON.stringify(row), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 15,
    });
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return json({ error: why.slice(0, 180) }, 502, request);
  }
  return json({ stats: row }, 200, request);
}
