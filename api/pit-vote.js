import { put, list } from "@vercel/blob";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const FEE = 100000000n;
const PIT = String(
  process.env.ARENA_PIT_SUI ||
    "0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c"
).toLowerCase();
const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const RPCS = [
  process.env.SUI_RPC,
  "https://mainnet.suiet.app",
  "https://rpc-mainnet.suiscan.xyz:443",
  "https://sui-mainnet-endpoint.blockvision.org",
].filter(Boolean);
const TICKER_RE = /^[A-Z][A-Z0-9]{1,11}$/;
const DIGEST_RE = /^[A-Za-z0-9]+$/;
const LIVE = "live";
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 20;
const hits = new Map();

const TX_GQL = `query ($d: String!) {
  transaction(digest: $d) {
    digest
    sender { address }
    transactionJson
    effects {
      status
      objectChanges(first: 40) { nodes { address } }
      balanceChanges(first: 40) {
        nodes {
          amount
          coinType { repr }
          owner {
            ... on AddressOwner { address }
            ... on ObjectOwner { address }
          }
        }
      }
    }
  }
}`;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function ownerAddress(owner) {
  if (!owner || typeof owner !== "object") return "";
  return String(owner.address || owner.ObjectOwner || owner.objectOwner || owner.AddressOwner || "").toLowerCase();
}

async function gqlTx(digest) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: TX_GQL, variables: { d: digest } }),
  });
  const j = await r.json();
  if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql");
  return j && j.data && j.data.transaction;
}

async function rpcTx(digest) {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "sui_getTransactionBlock",
    params: [digest, { showInput: true, showEffects: true, showBalanceChanges: true, showObjectChanges: true }],
  });
  let last = "rpc";
  for (let i = 0; i < RPCS.length; i++) {
    try {
      const r = await fetch(RPCS[i], { method: "POST", headers: { "content-type": "application/json" }, body });
      const j = await r.json();
      if (j && j.result) return j.result;
      last = (j && j.error && j.error.message) || last;
    } catch (e) {
      last = (e && e.message) || last;
    }
  }
  throw new Error(last);
}

function feePaidGql(tx, sender) {
  if (!tx || !tx.effects) return false;
  const status = String(tx.effects.status || "");
  if (status && status !== "SUCCESS") return false;
  const from = String((tx.sender && tx.sender.address) || "").toLowerCase();
  if (from && from !== sender.toLowerCase()) return false;
  const nodes = (tx.effects.balanceChanges && tx.effects.balanceChanges.nodes) || [];
  let spent = false;
  let pitGot = false;
  for (let i = 0; i < nodes.length; i++) {
    const c = nodes[i] || {};
    const typ = String((c.coinType && c.coinType.repr) || c.coinType || "");
    if (!/::sui::sui$/i.test(typ)) continue;
    let amt = 0n;
    try { amt = BigInt(String(c.amount || "0")); } catch (e) { amt = 0n; }
    const oid = ownerAddress(c.owner);
    if (amt <= -FEE && (oid === sender.toLowerCase() || !oid)) spent = true;
    if (amt >= FEE && oid === PIT) pitGot = true;
  }
  const objs = (tx.effects.objectChanges && tx.effects.objectChanges.nodes) || [];
  let mutatedPit = false;
  for (let i = 0; i < objs.length; i++) {
    if (String((objs[i] && objs[i].address) || "").toLowerCase() === PIT) mutatedPit = true;
  }
  const blob = JSON.stringify(tx);
  if ((spent || pitGot) && (mutatedPit || /take_fee/i.test(blob))) return true;
  return /take_fee/i.test(blob) && blob.indexOf("100000000") >= 0;
}

function feePaidRpc(tx, sender) {
  if (!tx || !tx.effects || !tx.effects.status || tx.effects.status.status !== "success") return false;
  const from = String((tx.transaction && tx.transaction.data && tx.transaction.data.sender) || "").toLowerCase();
  if (from && from !== sender.toLowerCase()) return false;
  const blob = JSON.stringify(tx);
  const objs = tx.objectChanges || [];
  let mutatedPit = false;
  for (let i = 0; i < objs.length; i++) {
    if (String((objs[i] && objs[i].objectId) || "").toLowerCase() === PIT) mutatedPit = true;
  }
  const changes = tx.balanceChanges || [];
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i] || {};
    if (!/::sui::sui$/i.test(String(c.coinType || ""))) continue;
    let amt = 0n;
    try { amt = BigInt(String(c.amount || "0")); } catch (e) { amt = 0n; }
    if (amt <= -FEE) {
      if (mutatedPit || /take_fee/i.test(blob)) return true;
    }
  }
  return mutatedPit && /take_fee/i.test(blob);
}

async function loadTx(digest) {
  let last = "transaction not indexed yet";
  for (let i = 0; i < 8; i++) {
    try {
      const g = await gqlTx(digest);
      if (g) return { kind: "gql", tx: g };
    } catch (e) {
      last = (e && e.message) || last;
    }
    try {
      const r = await rpcTx(digest);
      if (r) return { kind: "rpc", tx: r };
    } catch (e) {
      last = (e && e.message) || last;
    }
    await sleep(400 + i * 200);
  }
  throw new Error(last);
}

async function blobJson(url) {
  const r = await fetch(url, { cache: "no-store" });
  if (!r.ok) return null;
  try { return await r.json(); } catch (e) { return null; }
}

async function listVotes() {
  const out = [];
  try {
    const { blobs } = await list({ prefix: "pit-votes/" + LIVE + "/", limit: 200 });
    const rows = await Promise.all((blobs || []).map(function (b) { return blobJson(b.url); }));
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

function payload(votes, mine) {
  return { round: LIVE, votes: votes, tallies: tallies(votes), mine: mine || "", fee: "0.1" };
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  const votes = await listVotes();
  return json(payload(votes), 200, request);
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
  if (!DIGEST_RE.test(digest) || digest.length < 20 || digest.length > 88) {
    return json({ error: "bad digest" }, 400, request);
  }
  if (!TICKER_RE.test(ticker)) return json({ error: "bad ticker" }, 400, request);
  if (!rateOk(clientIp(request) + ":" + address)) {
    return json({ error: "vote quota (20/hour)" }, 429, request);
  }
  let loaded;
  try {
    loaded = await loadTx(digest);
  } catch (e) {
    return json({ error: "could not load vote transaction" }, 400, request);
  }
  const ok = loaded.kind === "gql" ? feePaidGql(loaded.tx, address) : feePaidRpc(loaded.tx, address);
  if (!ok) {
    return json({ error: "transaction did not pay 0.1 SUI into the pit" }, 400, request);
  }
  const row = {
    address: address,
    ticker: ticker,
    digest: digest,
    ts: Date.now(),
  };
  try {
    await put("pit-votes/tx/" + digest + ".json", JSON.stringify({ digest: digest, address: address, ticker: ticker }), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
    });
    await put("pit-votes/" + LIVE + "/" + address + ".json", JSON.stringify(row), {
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
  const votes = await listVotes();
  if (!votes.some(function (v) { return String(v.digest) === digest; })) {
    votes.unshift(row);
  }
  return json(payload(votes, ticker), 200, request);
}
