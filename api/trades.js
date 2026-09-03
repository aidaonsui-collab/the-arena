import { put, list } from "@vercel/blob";

const TICKER_RE = /^[A-Z][A-Z0-9_.\-]{0,15}$/;
const MAX_LIMIT = 500;

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

function padId(v) {
  let a = String(v || "").toLowerCase().replace(/^0x/, "");
  if (!a || /[^0-9a-f]/.test(a)) return "";
  while (a.length < 64) a = "0" + a;
  return "0x" + a;
}

function blobPath(ticker) {
  return "trades/" + ticker + ".json";
}

function authOk(request) {
  const secret = process.env.CRON_SECRET || process.env.ARENA_SETTLE_SECRET || "";
  if (!secret) return !process.env.VERCEL;
  const raw = request.headers.get("authorization") || "";
  return raw === "Bearer " + secret;
}

async function loadTicker(ticker) {
  try {
    const { blobs } = await list({ prefix: blobPath(ticker), limit: 8 });
    const path = blobPath(ticker);
    const hit =
      (blobs || []).find(function (b) {
        return b.pathname === path || String(b.pathname || "").endsWith("/" + path);
      }) || (blobs || [])[0];
    if (!hit) return { ticker, trades: [], count: 0, updatedMs: 0 };
    const r = await fetch(hit.url, { cache: "no-store" });
    if (!r.ok) return { ticker, trades: [], count: 0, updatedMs: 0 };
    const row = await r.json();
    if (!row || typeof row !== "object") return { ticker, trades: [], count: 0, updatedMs: 0 };
    const trades = Array.isArray(row.trades) ? row.trades : [];
    return {
      ticker: row.ticker || ticker,
      trades,
      count: Number(row.count || trades.length) || trades.length,
      updatedMs: Number(row.updatedMs || 0) || 0,
    };
  } catch {
    return { ticker, trades: [], count: 0, updatedMs: 0 };
  }
}

function tradeId(t) {
  if (t && t.id) return String(t.id);
  return [t && t.digest, t && t.seq, t && t.pool_id].join(":");
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const url = new URL(request.url);
  const ticker = safeTicker(url.searchParams.get("t") || url.searchParams.get("ticker"));
  if (!ticker) return json({ error: "ticker required" }, 400, request);
  const pool = padId(url.searchParams.get("pool") || "");
  const wallet = String(url.searchParams.get("wallet") || "").toLowerCase();
  const limit = Math.min(MAX_LIMIT, Math.max(1, Number(url.searchParams.get("limit") || 200) || 200));
  const before = Number(url.searchParams.get("before") || 0) || 0;
  const blob = await loadTicker(ticker);
  let rows = blob.trades || [];
  if (pool) rows = rows.filter(function (t) { return padId(t.pool_id) === pool; });
  if (wallet) {
    const w = wallet.replace(/^0x/, "");
    rows = rows.filter(function (t) {
      const a = String(t.trader || "").toLowerCase().replace(/^0x/, "");
      return a === w || (w.length >= 8 && (a.indexOf(w) === 0 || w.indexOf(a) === 0));
    });
  }
  rows.sort(function (a, b) { return Number(b.ts || 0) - Number(a.ts || 0); });
  const total = rows.length;
  if (before > 0) rows = rows.filter(function (t) { return Number(t.ts || 0) < before; });
  const sliced = rows.slice(0, limit);
  const last = sliced[sliced.length - 1];
  const nextBefore = sliced.length === limit && last ? Number(last.ts || 0) : 0;
  return json(
    {
      ticker,
      count: total,
      returned: sliced.length,
      updatedMs: blob.updatedMs,
      nextBefore,
      trades: sliced,
    },
    200,
    request,
    { "cache-control": "no-store" },
  );
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
  const incoming = Array.isArray(body.trades) ? body.trades : [];
  const prev = await loadTicker(ticker);
  const map = new Map();
  (prev.trades || []).forEach(function (t) {
    map.set(tradeId(t), t);
  });
  incoming.forEach(function (t) {
    if (!t) return;
    map.set(tradeId(t), t);
  });
  const trades = Array.from(map.values()).sort(function (a, b) {
    return Number(b.ts || 0) - Number(a.ts || 0);
  });
  const row = {
    ticker,
    count: trades.length,
    updatedMs: Date.now(),
    trades,
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
  return json({ ticker, count: trades.length }, 200, request);
}
