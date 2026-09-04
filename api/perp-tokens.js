import { put } from "@vercel/blob";
import { readJsonBlob, rememberJsonBlob } from "./_blob-json.js";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const PLATFORM = normalizeSuiAddress(
  process.env.ARENA_PLATFORM || "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b"
);
const TICKER_RE = /^[A-Z][A-Z0-9_.\-]{0,15}$/;
const CATALOG = "perp-tokens.json";
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 12;
const hits = new Map();

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

function clientIp(request) {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "unknown";
}

function rateOk(key) {
  const now = Date.now();
  const row = hits.get(key) || [];
  const fresh = row.filter((t) => now - t < WINDOW_MS);
  if (fresh.length >= MAX_PER_WINDOW) {
    hits.set(key, fresh);
    return false;
  }
  fresh.push(now);
  hits.set(key, fresh);
  return true;
}

function asString(v) {
  return v == null ? "" : String(v).trim();
}

function safeTicker(v) {
  const t = asString(v).toUpperCase();
  return TICKER_RE.test(t) ? t : "";
}

function blobPath(ticker) {
  return "perp-tokens/" + ticker + ".json";
}

function authCron(request) {
  const secret = process.env.CRON_SECRET || process.env.ARENA_SETTLE_SECRET || "";
  if (!secret) return !process.env.VERCEL;
  const raw = request.headers.get("authorization") || "";
  return raw === "Bearer " + secret;
}

function publicRow(row) {
  if (!row || typeof row !== "object") return null;
  return {
    ticker: row.ticker || "",
    name: row.name || "",
    desc: row.desc || "",
    img: row.img || "",
    creator: row.creator || "",
    vaultId: row.vaultId || "",
    lpCoinType: row.lpCoinType || "",
    pending: !!row.pending,
    navUsd: Number(row.navUsd) || 0,
    tvlUsd: Number(row.tvlUsd) || 0,
    amcPx: Number(row.amcPx) || 0,
    leverage: Number(row.leverage) || 0,
    posSize: String(row.posSize || "0"),
    updatedMs: Number(row.updatedMs) || 0,
  };
}

async function loadCatalog() {
  const empty = { tokens: [], updatedMs: 0 };
  const row = await readJsonBlob(CATALOG, empty);
  if (!row || typeof row !== "object") return empty;
  const tokens = Array.isArray(row.tokens) ? row.tokens.map(publicRow).filter(Boolean) : [];
  return { tokens, updatedMs: Number(row.updatedMs) || 0 };
}

async function saveCatalog(catalog) {
  const body = { tokens: catalog.tokens, updatedMs: Date.now() };
  await put(CATALOG, JSON.stringify(body), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    allowOverwrite: true,
  });
  rememberJsonBlob(CATALOG, body);
  return body;
}

async function loadTicker(ticker) {
  const t = safeTicker(ticker);
  if (!t) return null;
  const row = await readJsonBlob(blobPath(t), null);
  return publicRow(row);
}

async function saveTicker(row) {
  const t = safeTicker(row.ticker);
  if (!t) throw new Error("ticker required");
  const next = Object.assign({ ticker: t }, row, { ticker: t, updatedMs: Date.now() });
  await put(blobPath(t), JSON.stringify(next), {
    access: "public",
    addRandomSuffix: false,
    contentType: "application/json",
    allowOverwrite: true,
  });
  rememberJsonBlob(blobPath(t), next);
  const cat = await loadCatalog();
  const i = cat.tokens.findIndex((x) => x.ticker === t);
  const pub = publicRow(next);
  if (i >= 0) cat.tokens[i] = pub;
  else cat.tokens.push(pub);
  await saveCatalog(cat);
  return pub;
}

function sameAddr(a, b) {
  try {
    return normalizeSuiAddress(a) === normalizeSuiAddress(b);
  } catch {
    return false;
  }
}

const AF = "https://aftermath.finance/api/perpetuals";
const OBJECT_ID_RE = /^0x[0-9a-f]{1,64}$/i;

/// A listed AMC vault is one the platform controls. The launch flow ends by
/// handing the VaultCap to the platform wallet ("Sign 3 of 3 · hand to Vice"),
/// and the keeper already refuses to trade a vault it does not own. Nothing
/// enforced that on the way in, so the catalog would accept any vaultId — and
/// the buy path feeds vaultId straight into Aftermath's deposit builder, so a
/// vault the lister still controls collects other people's USDC.
///
/// Fails closed: if Aftermath cannot be reached, or the owner does not match,
/// the write is rejected rather than trusted.
async function readVault(vaultId) {
  try {
    const r = await fetch(AF + "/vaults", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ vaultIds: [vaultId] }),
    });
    if (!r.ok) return { err: "could not reach Aftermath to check the vault" };
    const j = await r.json();
    return { vault: (Array.isArray(j && j.vaults) ? j.vaults[0] : null) || null };
  } catch {
    return { err: "could not reach Aftermath to check the vault" };
  }
}

async function vaultOwnedByPlatform(vaultId) {
  if (!OBJECT_ID_RE.test(vaultId)) return { ok: false, why: "vaultId is not an object id" };
  // The launch flow hands the VaultCap over and posts in the next breath, so
  // Aftermath's view of the owner can lag the transfer by a second or two.
  // Retry briefly rather than failing a launch that is actually correct.
  let vault = null;
  let why = "no such Aftermath vault";
  for (let attempt = 0; attempt < 4; attempt++) {
    if (attempt) await new Promise((r) => setTimeout(r, 400 * attempt));
    const got = await readVault(vaultId);
    if (got.err) { why = got.err; continue; }
    vault = got.vault;
    if (!vault) { why = "no such Aftermath vault"; continue; }
    if (sameAddr(vault.ownerAddress, PLATFORM)) break;
    why = "vault is not controlled by Vice — hand the VaultCap over first";
    vault = null;
  }
  if (!vault) return { ok: false, why };
  // Take lpCoinType from the vault rather than the request: it scales withdraw
  // amounts by 1e6 vs 1e9 in the sell path, so a wrong value is a real error.
  return { ok: true, lpCoinType: String(vault.lpCoinType || "") };
}

async function verifyPerpSig(address, signature, ts, ticker) {
  const t = Number(ts);
  if (!address || !signature || !Number.isFinite(t)) return false;
  if (Math.abs(Date.now() - t) > 10 * 60 * 1000) return false;
  const addr = normalizeSuiAddress(address);
  const msg = new TextEncoder().encode("vice-perp:" + t + ":" + ticker);
  const pub = await verifyPersonalMessageSignature(msg, signature, { address: addr });
  return normalizeSuiAddress(pub.toSuiAddress()) === addr;
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  const url = new URL(request.url);
  const ticker = safeTicker(url.searchParams.get("t") || url.searchParams.get("ticker"));
  const cache = { "cache-control": "public, s-maxage=15, stale-while-revalidate=60" };
  if (ticker) {
    const token = await loadTicker(ticker);
    return json({ token }, 200, request, cache);
  }
  const catalog = await loadCatalog();
  return json(catalog, 200, request, cache);
}

export async function POST(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400, request);
  }
  const ticker = safeTicker(body && (body.ticker || body.t));
  if (!ticker) return json({ error: "ticker required" }, 400, request);
  const prev = (await loadTicker(ticker)) || {};

  if (authCron(request)) {
    const merged = Object.assign({}, prev, {
      ticker,
      vaultId: asString(body.vaultId) || prev.vaultId || "",
      lpCoinType: asString(body.lpCoinType) || prev.lpCoinType || "",
      navUsd: body.navUsd != null ? Number(body.navUsd) : prev.navUsd,
      tvlUsd: body.tvlUsd != null ? Number(body.tvlUsd) : prev.tvlUsd,
      amcPx: body.amcPx != null ? Number(body.amcPx) : prev.amcPx,
      leverage: body.leverage != null ? Number(body.leverage) : prev.leverage,
      posSize: body.posSize != null ? String(body.posSize) : prev.posSize,
      pending: body.pending != null ? !!body.pending : prev.pending,
    });
    const token = await saveTicker(merged);
    return json({ token }, 200, request);
  }

  const address = asString(body && body.address);
  const rawSig = body && body.signature;
  const signature = asString(rawSig && typeof rawSig === "object" ? rawSig.signature : rawSig);
  const ts = asString(body && body.ts);
  try {
    if (!(await verifyPerpSig(address, signature, ts, ticker))) {
      return json({ error: "sign vice-perp:<ts>:<ticker> with the connected wallet" }, 401, request);
    }
  } catch (e) {
    const why = e && e.message ? String(e.message) : "invalid signature";
    return json({ error: why.slice(0, 180) }, 401, request);
  }
  const addr = normalizeSuiAddress(address);
  if (!rateOk(clientIp(request) + ":" + addr)) return json({ error: "update quota (12/hour)" }, 429, request);
  const isPlatform = sameAddr(addr, PLATFORM);
  if (prev.creator && !sameAddr(addr, prev.creator) && !isPlatform) {
    return json({ error: "only the creator or platform can update this AMC token" }, 403, request);
  }
  // vaultId decides where buyer deposits land, so it is not ordinary metadata.
  // Once a verified vault is attached only the platform may repoint it, which
  // also means a replayed signature cannot move an existing listing.
  const wantVault = asString(body.vaultId);
  let vaultId = prev.vaultId || "";
  let lpCoinType = prev.lpCoinType || "";
  if (wantVault && wantVault !== vaultId) {
    if (vaultId && !isPlatform) {
      return json({ error: "this listing already has a vault; only the platform can repoint it" }, 403, request);
    }
    const check = await vaultOwnedByPlatform(wantVault);
    if (!check.ok) return json({ error: check.why }, 400, request);
    vaultId = wantVault;
    lpCoinType = check.lpCoinType || asString(body.lpCoinType) || lpCoinType;
  }

  const merged = Object.assign({}, prev, {
    ticker,
    name: asString(body.name) || prev.name || ticker,
    desc: asString(body.desc) || prev.desc || "",
    img: asString(body.img) || prev.img || "",
    creator: prev.creator || addr,
    vaultId,
    lpCoinType,
    pending: body.pending != null ? !!body.pending : prev.pending || !vaultId,
  });
  const token = await saveTicker(merged);
  return json({ token }, 200, request);
}
