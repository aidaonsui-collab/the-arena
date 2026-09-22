import { put } from "@vercel/blob";
import { readJsonBlob, rememberJsonBlob } from "./_blob-json.js";
import { keeperAuthOk } from "./_keeper-auth.js";

const BLOB_PATH = "screener.json";
const CACHE = "public, s-maxage=25, stale-while-revalidate=60";

function json(body, status, extra) {
  return Response.json(body, {
    status: status || 200,
    headers: Object.assign({ "cache-control": status === 200 ? CACHE : "no-store" }, extra || {}),
  });
}

export async function GET() {
  const row = await readJsonBlob(BLOB_PATH, null);
  if (!row || !Array.isArray(row.tokens)) {
    return json({ tokens: [], updatedMs: 0, stale: true }, 200);
  }
  return json(row, 200);
}

export async function POST(request) {
  if (!keeperAuthOk(request)) return json({ error: "unauthorized" }, 401);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400);
  }
  const tokens = Array.isArray(body && body.tokens) ? body.tokens : [];
  const row = {
    updatedMs: Date.now(),
    tokens: tokens.map(function (t) {
      return {
        ticker: String((t && t.ticker) || "").toUpperCase(),
        mcUsd: Number(t && t.mcUsd) || 0,
        burned: String((t && t.burned) || "0"),
        coinA: String((t && t.coinA) || "0"),
        coinB: String((t && t.coinB) || "0"),
        sqrt: String((t && t.sqrt) || "0"),
        quote: String((t && t.quote) || "SUI"),
        pool: String((t && t.pool) || ""),
        vol24: Number(t && t.vol24) || 0,
        chg24: Number(t && t.chg24) || 0,
        pts: Array.isArray(t && t.pts) ? t.pts.slice(0, 24) : [],
        buys: Number(t && t.buys) || 0,
        sells: Number(t && t.sells) || 0,
        traders: Number(t && t.traders) || 0,
      };
    }).filter(function (t) { return t.ticker; }),
  };
  try {
    await put(BLOB_PATH, JSON.stringify(row), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 15,
    });
    rememberJsonBlob(BLOB_PATH, row);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return json({ error: why.slice(0, 180) }, 502);
  }
  return json({ ok: true, tokens: row.tokens.length, updatedMs: row.updatedMs }, 200);
}
