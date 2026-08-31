import { put, list } from "@vercel/blob";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const FEE = 100000000n;
const PIT = String(
  process.env.ARENA_PIT_SUI ||
    "0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c"
).toLowerCase();
const RPC = process.env.SUI_RPC || "https://fullnode.mainnet.sui.io:443";
const TICKER_RE = /^[A-Z][A-Z0-9]{1,11}$/;
const DIGEST_RE = /^[A-Za-z0-9]+$/;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map();

function vercelHost(v) {
  if (!v) return "";
  return v.startsWith("http") ? v.replace(/\/$/, "") : `https://${v}`;
}

function originOk(request) {
  const origin = (request.headers.get("origin") || "").replace(/\/$/, "");
  if (!origin) return true;
  if (/the-arena|\.vercel\.app$/i.test(origin)) return true;
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
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function json(body, status, request) {
  return Response.json(body, { status, headers: corsHeaders(request) });
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

function roundKey(round) {
  const n = Number(round);
  if (!Number.isFinite(n) || n < 0) return "0";
  return String(Math.floor(n));
}

function ownerId(owner) {
  if (!owner || typeof owner !== "object") return "";
  if (typeof owner.ObjectOwner === "string") return owner.ObjectOwner;
  if (typeof owner.objectOwner === "string") return owner.objectOwner;
  if (typeof owner.AddressOwner === "string") return owner.AddressOwner;
  if (owner.Shared && typeof owner.Shared.objectId === "string") return owner.Shared.objectId;
  return "";
}

async function suiTx(digest) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sui_getTransactionBlock",
      params: [
        digest,
        { showInput: true, showEffects: true, showBalanceChanges: true, showObjectChanges: true },
      ],
    }),
  });
  const j = await r.json();
  if (j && j.error) throw new Error(j.error.message || "rpc");
  return j && j.result;
}

function feePaid(tx, sender) {
  if (!tx || !tx.effects || !tx.effects.status || tx.effects.status.status !== "success") return false;
  const from = String((tx.transaction && tx.transaction.data && tx.transaction.data.sender) || "").toLowerCase();
  if (from !== sender.toLowerCase()) return false;
  const changes = tx.balanceChanges || [];
  let spent = false;
  let pitGot = false;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i] || {};
    if (!/::sui::sui$/i.test(String(c.coinType || ""))) continue;
    let amt = 0n;
    try { amt = BigInt(String(c.amount || "0")); } catch (e) { amt = 0n; }
    const oid = ownerId(c.owner).toLowerCase();
    if (amt <= -FEE && (oid === from || !oid)) spent = true;
    if (amt >= FEE && oid === PIT) pitGot = true;
  }
  const objs = tx.objectChanges || [];
  let mutatedPit = false;
  for (let i = 0; i < objs.length; i++) {
    const c = objs[i] || {};
    if (String(c.objectId || "").toLowerCase() === PIT) mutatedPit = true;
  }
  if ((spent || pitGot) && mutatedPit) return true;
  const blob = JSON.stringify(tx);
  return /pit::take_fee/i.test(blob) && amtHint(blob);
}

function amtHint(blob) {
  return blob.indexOf("100000000") >= 0 || blob.indexOf(String(FEE)) >= 0;
}

async function blobJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}

async function listVotes(round) {
  const prefix = "pit-votes/" + round + "/";
  const out = [];
  try {
    const { blobs } = await list({ prefix: prefix, limit: 200 });
    const rows = await Promise.all(
      (blobs || []).map(function (b) { return blobJson(b.url); })
    );
    rows.forEach(function (row) {
      if (row && row.address && row.ticker) out.push(row);
    });
  } catch (e) {}
  out.sort(function (a, b) { return Number(b.ts || 0) - Number(a.ts || 0); });
  return out;
}

function tallies(votes) {
  const t = {};
  votes.forEach(function (v) {
    const k = String(v.ticker || "").toUpperCase();
    if (!k) return;
    t[k] = (t[k] || 0) + 1;
  });
  return t;
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  const url = new URL(request.url);
  const round = roundKey(url.searchParams.get("round") || "0");
  const votes = await listVotes(round);
  return json({ round: Number(round), votes: votes, tallies: tallies(votes), fee: "0.1" }, 200, request);
}

export async function POST(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  let body;
  try { body = await request.json(); } catch (e) {
    return json({ error: "bad json" }, 400, request);
  }
  const digest = String((body && body.digest) || "").trim();
  const ticker = String((body && body.ticker) || "").trim().toUpperCase();
  let address;
  try { address = normalizeSuiAddress(String((body && body.address) || "")); } catch (e) {
    return json({ error: "bad address" }, 400, request);
  }
  const round = roundKey(body && body.round);
  if (!DIGEST_RE.test(digest) || digest.length < 20 || digest.length > 88) {
    return json({ error: "bad digest" }, 400, request);
  }
  if (!TICKER_RE.test(ticker)) return json({ error: "bad ticker" }, 400, request);
  if (!rateOk(clientIp(request) + ":" + address)) {
    return json({ error: "vote quota (20/hour)" }, 429, request);
  }
  let tx;
  try { tx = await suiTx(digest); } catch (e) {
    return json({ error: "could not load vote transaction" }, 400, request);
  }
  if (!feePaid(tx, address)) {
    return json({ error: "transaction did not pay 0.1 SUI into the pit" }, 400, request);
  }
  try {
    const seen = await list({ prefix: "pit-votes/tx/" + digest, limit: 1 });
    if (seen && seen.blobs && seen.blobs.length) {
      return json({ error: "that vote transaction was already counted" }, 409, request);
    }
  } catch (e) {}
  const row = {
    address: address,
    ticker: ticker,
    digest: digest,
    ts: Date.now(),
    round: Number(round),
  };
  try {
    await put("pit-votes/tx/" + digest + ".json", JSON.stringify({ digest: digest, address: address }), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: false,
      contentType: "application/json",
    });
  } catch (e) {
    const msg = e && e.message ? String(e.message) : "";
    if (/already exists|overwrite|conflict/i.test(msg)) {
      return json({ error: "that vote transaction was already counted" }, 409, request);
    }
    return json({ error: (msg || "blob put failed").slice(0, 180) }, 502, request);
  }
  try {
    await put("pit-votes/" + round + "/" + address + ".json", JSON.stringify(row), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 0,
    });
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return json({ error: why.slice(0, 180) }, 502, request);
  }
  const votes = await listVotes(round);
  return json({ round: Number(round), votes: votes, tallies: tallies(votes), mine: ticker, fee: "0.1" }, 200, request);
}
