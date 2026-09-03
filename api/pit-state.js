import { put, list } from "@vercel/blob";

const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const EVENT_PKG =
  process.env.ARENA_INSTADEX_PACKAGE ||
  "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3";
const ROUND_MS = 86_400_000;
const COOLDOWN_MS = 172_800_000;
const SUPPLY = 1e9;
const HIDE = new Set(["BFLN", "GRAD", "SMOKE", "IDEX", "SILVER"]);
// One-token sit-out skip: GOLDY won the last bell so the blob still lists it.
// Keep the 48h cooldown for every other winner.
const SITOUT_EXEMPT = new Set(["GOLDY"]);
const PATH = "pit-state.json";
const SETTLES_PATH = "pit-settles.json";
const SETTLE_EVENT =
  process.env.ARENA_PIT_SETTLE_EVENT ||
  "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9::events::InstadexPitSettleEvent";
const BURN_EVENT =
  process.env.ARENA_BURN_EVENT ||
  "0x47ea732e44f21470aa3dd449a7b26731ed2c377e2c02e650f3ede6ea581bf000::events::InstadexBurnEvent";
const RPCS = [
  process.env.SUI_RPC || "https://mainnet.suiet.app",
  "https://rpc-mainnet.suiscan.xyz:443",
  "https://sui-mainnet-endpoint.blockvision.org",
];
const Q64 = 2 ** 64;
const USDY = "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY";
const XAGM = "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM";
const XAUM = "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";

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

function settleAuth(request) {
  const hdr = request.headers.get("authorization") || "";
  const token = hdr.replace(/^Bearer\s+/i, "").trim();
  if (!token) return false;
  const secrets = [process.env.CRON_SECRET, process.env.ARENA_SETTLE_SECRET].filter(Boolean);
  return secrets.includes(token);
}

function json(body, status, request) {
  return Response.json(body, {
    status,
    headers: {
      ...corsHeaders(request),
      "cache-control": "private, no-store",
    },
  });
}

async function gql(query, variables) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql");
  return j.data;
}

function asId(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") {
    const s = v.startsWith("0x") ? v : "0x" + v;
    return s;
  }
  if (typeof v === "object" && v.id) return asId(v.id);
  return String(v);
}

function typeNameOf(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") {
    if (v.includes("::") && !v.startsWith("0x") && !v.startsWith("0X")) return "0x" + v;
    return v;
  }
  if (typeof v === "object") {
    if (v.address && v.module) return asId(v.address) + "::" + v.module + "::" + (v.name || "");
    if (v.name) return typeNameOf(String(v.name));
  }
  return String(v);
}

function quoteMeta(type) {
  const s = String(type || "");
  if (/usdy/i.test(s) || s === USDY) return { label: "USDY", dec: 6 };
  if (/xagm/i.test(s) || s === XAGM) return { label: "XAGM", dec: 9 };
  if (/xaum/i.test(s) || s === XAUM) return { label: "XAUM", dec: 9 };
  return { label: "SUI", dec: 9 };
}

function tickerOf(sym, token) {
  const s = String(sym || "").toUpperCase();
  if (s) return s.slice(0, 12);
  const t = typeNameOf(token);
  const i = t.lastIndexOf("::");
  return (i >= 0 ? t.slice(i + 2) : t).toUpperCase().slice(0, 12);
}

function hiddenLaunch(t, n) {
  if (HIDE.has(t)) return true;
  return /^Arena (Bluefin|Grad|Smoke)$/i.test(n || "") || /^INSTA$/i.test(n || "");
}

async function hopPrices() {
  const [suiUsdc, suiRes, usdy, xagm, xaum] = await Promise.all([
    fetch("https://api.dexpaprika.com/networks/sui/pools/0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd", { cache: "no-store" }).catch(() => null),
    fetch("https://api.dexpaprika.com/networks/sui/pools/0xdcd762ad374686fa890fc4f3b9bbfe2a244e713d7bffbfbd1b9221cb290da2ed", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    fetch("https://api.dexpaprika.com/networks/sui/pools/0x4d3cc875e334440ad3485d4455d7ee072ea01b18c526ad64f9ebe2aa0a4f01b9", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
    fetch("https://api.dexpaprika.com/networks/sui/pools/0x458fc3722cc88babd7cbe78273aa5e4ecbdff75c76a2ad14cd1f75418b569649", { cache: "no-store" }).then((r) => r.json()).catch(() => null),
  ]);
  let suiUsd = Number((suiUsdc && (suiUsdc.last_price_usd || suiUsdc.last_price)) || 0);
  try {
    if (!(suiUsd > 0) && suiRes && suiRes.ok) {
      const g = await suiRes.json();
      suiUsd = Number(g && g.sui && g.sui.usd) || 0;
    }
  } catch (e) {}
  const usdyUsd = Number((usdy && (usdy.last_price_usd || usdy.last_price)) || 0);
  const xagmUsd = Number((xagm && (xagm.last_price_usd || xagm.last_price)) || 0);
  const xaumUsd = Number((xaum && (xaum.last_price_usd || xaum.last_price)) || 0);
  return {
    SUI: suiUsd,
    USDY: usdyUsd > 0 ? usdyUsd : 1,
    XAGM: xagmUsd,
    XAUM: xaumUsd,
  };
}

function numSqrt(v) {
  if (v == null || v === "") return 0;
  if (typeof v === "object") return Number(v.value || v.amount || 0);
  return Number(v);
}

// Bluefin Q64: raw = (sqrt/2^64)^2 = coinB_raw / coinA_raw.
// Instant pools are Pool<TOKEN, QUOTE>. Human quote per token = raw * 10^(decA-decB).
function mcUsd(sqrt, decA, decB, quoteUsd) {
  const s = numSqrt(sqrt);
  if (!(s > 0) || !(quoteUsd > 0)) return 0;
  const raw = (s / Q64) * (s / Q64);
  const px = raw * Math.pow(10, decA - decB);
  if (!(px > 0) || !isFinite(px)) return 0;
  const n = px * SUPPLY * quoteUsd;
  if (!(n > 0) || n > 1e10) return 0;
  return n;
}

async function listLaunches() {
  const type = EVENT_PKG + "::events::InstadexLaunchEvent";
  const q =
    "query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }";
  const out = [];
  let after = null;
  for (let i = 0; i < 6; i++) {
    const data = await gql(q, { t: type, first: 50, after });
    const nodes = (data && data.events && data.events.nodes) || [];
    for (let j = 0; j < nodes.length; j++) {
      const p = (nodes[j].contents && nodes[j].contents.json) || {};
      const t = tickerOf(p.symbol, p.token);
      const n = String(p.name || t);
      if (!t || hiddenLaunch(t, n)) continue;
      out.push({
        t: t,
        n: n,
        pool: asId(p.bluefin_pool_id),
        lock: asId(p.lock_id),
        token: typeNameOf(p.token),
        quote: typeNameOf(p.quote),
      });
    }
    const info = (data && data.events && data.events.pageInfo) || {};
    if (!info.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  const seen = {};
  const uniq = [];
  for (let i = 0; i < out.length; i++) {
    if (seen[out[i].t]) continue;
    seen[out[i].t] = 1;
    uniq.push(out[i]);
  }
  return uniq;
}

async function poolJson(id) {
  if (!id) return null;
  const q =
    "query($id:SuiAddress!){ object(address:$id){ asMoveObject { contents { type { repr } json } } } }";
  try {
    const data = await gql(q, { id: id });
    const c = data && data.object && data.object.asMoveObject && data.object.asMoveObject.contents;
    return c && c.json ? { type: (c.type && c.type.repr) || "", json: c.json } : null;
  } catch (e) {
    return null;
  }
}

function emptyState(now) {
  return {
    round: 1,
    roundStartedMs: now,
    roundEndMs: now + ROUND_MS,
    settledAtEnd: 0,
    winner: null,
    banned: [],
    bells: [],
    standing: [],
    mode: "buy-burn",
    updatedMs: now,
  };
}

function normId(v) {
  return asId(v).toLowerCase();
}

function applySettleRow(b, row) {
  if (!b || !row) return;
  if (row.digest && !b.digest) b.digest = row.digest;
  if (row.skipped && !b.skipped) b.skipped = row.skipped;
  const amt = Number(row.amount);
  const brn = Number(row.burned);
  const hop = Number(row.quoteBought);
  if (amt > 0 && amt >= Number(b.amount || 0)) b.amount = row.amount;
  if (brn > 0 && brn >= Number(b.burned || 0)) b.burned = row.burned;
  if (hop > 0 && hop >= Number(b.quoteBought || 0)) b.quoteBought = row.quoteBought;
}

function applySettlesToBells(bells, byPool, byTicker) {
  (bells || []).forEach(function (b) {
    applySettleRow(b, byPool && byPool[normId(b.pool)]);
    applySettleRow(b, byTicker && byTicker[String(b.t || "").toUpperCase()]);
  });
}

function mergeBells(primary, extra) {
  const out = [];
  const seen = {};
  function take(b) {
    if (!b || !b.t) return;
    const k = String(b.t).toUpperCase() + ":" + String(b.ts || "");
    const prev = seen[k];
    if (!prev) {
      const row = Object.assign({}, b);
      seen[k] = row;
      out.push(row);
      return;
    }
    applySettleRow(prev, b);
    if (!prev.n && b.n) prev.n = b.n;
    if (!prev.pool && b.pool) prev.pool = b.pool;
    if (!prev.lock && b.lock) prev.lock = b.lock;
  }
  (primary || []).forEach(take);
  (extra || []).forEach(take);
  const byT = {};
  const byP = {};
  out.forEach(function (b) {
    const t = String(b.t || "").toUpperCase();
    const p = normId(b.pool);
    if (t) {
      if (!byT[t]) byT[t] = {};
      applySettleRow(byT[t], b);
    }
    if (p && p !== "0x") {
      if (!byP[p]) byP[p] = {};
      applySettleRow(byP[p], b);
    }
  });
  out.forEach(function (b) {
    applySettleRow(b, byT[String(b.t || "").toUpperCase()]);
    applySettleRow(b, byP[normId(b.pool)]);
  });
  return out;
}

function mergeOverlay(a, b) {
  const out = { byPool: {}, byTicker: {}, updatedMs: 0 };
  function fold(src) {
    if (!src) return;
    out.updatedMs = Math.max(Number(out.updatedMs || 0), Number(src.updatedMs || 0));
    Object.keys(src.byPool || {}).forEach(function (k) {
      const nk = normId(k);
      if (!out.byPool[nk]) out.byPool[nk] = Object.assign({}, src.byPool[k]);
      else applySettleRow(out.byPool[nk], src.byPool[k]);
    });
    Object.keys(src.byTicker || {}).forEach(function (k) {
      const t = String(k).toUpperCase();
      if (!out.byTicker[t]) out.byTicker[t] = Object.assign({}, src.byTicker[k]);
      else applySettleRow(out.byTicker[t], src.byTicker[k]);
    });
  }
  fold(a);
  fold(b);
  return out;
}

function overlayFrom(state, prevOverlay) {
  const out = mergeOverlay(prevOverlay, { byPool: {}, byTicker: {}, updatedMs: Date.now() });
  (state && state.bells ? state.bells : []).forEach(function (b) {
    if (!b || (!b.digest && !(Number(b.amount) > 0) && !(Number(b.burned) > 0) && !b.skipped)) return;
    const row = {
      digest: b.digest,
      amount: b.amount,
      burned: b.burned,
      quoteBought: b.quoteBought,
      skipped: b.skipped,
      t: b.t,
      pool: b.pool,
    };
    const p = normId(b.pool);
    const t = String(b.t || "").toUpperCase();
    if (p && p !== "0x") {
      if (!out.byPool[p]) out.byPool[p] = {};
      applySettleRow(out.byPool[p], row);
      out.byPool[p].t = t;
    }
    if (t) {
      if (!out.byTicker[t]) out.byTicker[t] = {};
      applySettleRow(out.byTicker[t], row);
      out.byTicker[t].pool = p;
    }
  });
  out.updatedMs = Date.now();
  return out;
}

function attachUsd(state, px) {
  (state.bells || []).forEach(function (b) {
    // Instant Fight Night drains Pit<SUI>. amount is always SUI mist.
    const raw = Number(b && b.amount);
    if (!(raw > 0)) return;
    const n = raw >= 1e7 ? raw / 1e9 : raw;
    const u = (px && px.SUI) || 0;
    if (n > 0 && u > 0) b.amountUsd = n * u;
  });
}

async function loadJsonPath(path) {
  try {
    const { blobs } = await list({ prefix: path, limit: 20 });
    const rows = blobs || [];
    if (!rows.length) return [];
    const parsed = [];
    for (let i = 0; i < rows.length; i++) {
      try {
        const r = await fetch(rows[i].url, { cache: "no-store" });
        if (!r.ok) continue;
        const j = await r.json();
        if (j && typeof j === "object") parsed.push(j);
      } catch (e) {}
    }
    parsed.sort(function (a, b) {
      return Number(b.updatedMs || 0) - Number(a.updatedMs || 0);
    });
    return parsed;
  } catch (e) {
    return [];
  }
}

async function loadBlob() {
  const parsed = await loadJsonPath(PATH);
  if (!parsed.length) return null;
  const state = parsed[0];
  for (let i = 1; i < parsed.length; i++) {
    state.bells = mergeBells(state.bells, parsed[i].bells);
  }
  return state;
}

async function loadSettles() {
  const parsed = await loadJsonPath(SETTLES_PATH);
  if (!parsed.length) return { byPool: {}, byTicker: {}, updatedMs: 0 };
  let overlay = { byPool: {}, byTicker: {}, updatedMs: 0 };
  for (let i = 0; i < parsed.length; i++) overlay = mergeOverlay(overlay, parsed[i]);
  return overlay;
}

async function saveJson(path, state) {
  await put(path, JSON.stringify(state), {
    access: "public",
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: "application/json",
    cacheControlMaxAge: 0,
  });
}

async function saveBlob(state) {
  await saveJson(PATH, state);
}

async function listEventRows(type) {
  const q =
    "query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { timestamp transaction { digest } contents { json } } } }";
  const out = [];
  let after = null;
  for (let i = 0; i < 6; i++) {
    const data = await gql(q, { t: type, first: 50, after });
    const nodes = (data && data.events && data.events.nodes) || [];
    for (let j = 0; j < nodes.length; j++) {
      const n = nodes[j];
      out.push({
        digest: (n.transaction && n.transaction.digest) || "",
        json: (n.contents && n.contents.json) || {},
        ts: Date.parse(n.timestamp) || 0,
      });
    }
    const info = (data && data.events && data.events.pageInfo) || {};
    if (!info.hasNextPage || !info.endCursor) break;
    after = info.endCursor;
  }
  return out;
}

async function rpcJson(method, params) {
  let last = null;
  for (let i = 0; i < RPCS.length; i++) {
    try {
      const r = await fetch(RPCS[i], {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
      });
      const j = await r.json();
      if (j && j.result) return j.result;
      last = (j && j.error && j.error.message) || method + " failed";
    } catch (e) {
      last = e && e.message ? e.message : String(e);
    }
  }
  throw new Error(last || method + " failed");
}

function parseSettleTx(tx, winnerId) {
  const out = { burned: 0, quoteBought: 0 };
  const winner = normId(winnerId);
  const events = (tx && tx.events) || [];
  for (let i = 0; i < events.length; i++) {
    const ev = events[i] || {};
    const t = String(ev.type || "");
    const p = ev.parsedJson || {};
    if (t.endsWith("::events::InstadexBurnEvent") || t === BURN_EVENT) {
      out.burned += Number(p.amount || 0);
    }
    if (!winner || winner === "0x") continue;
    if (t.endsWith("::events::AssetSwap") || t.endsWith("::pool::SwapEvent")) {
      const pool = normId(p.pool_id || p.pool);
      if (pool === winner) out.quoteBought = Number(p.amount_in || 0);
    }
  }
  return out;
}

async function chainSettlesByPool() {
  const settles = await listEventRows(SETTLE_EVENT);
  settles.sort(function (a, b) {
    return Number(a.ts || 0) - Number(b.ts || 0);
  });
  const digests = [];
  const seenD = {};
  for (let i = 0; i < settles.length; i++) {
    const d = settles[i].digest;
    if (!d || seenD[d]) continue;
    seenD[d] = 1;
    digests.push(d);
  }
  const txs = await Promise.all(
    digests.map(function (d) {
      return rpcJson("sui_getTransactionBlock", [d, { showEvents: true }]).catch(function () {
        return null;
      });
    }),
  );
  const byDigest = {};
  for (let i = 0; i < digests.length; i++) byDigest[digests[i]] = txs[i];
  const byPool = {};
  for (let i = 0; i < settles.length; i++) {
    const s = settles[i];
    const pool = normId(s.json.winner_id);
    if (!pool || pool === "0x") continue;
    const amount = Number(s.json.amount || 0);
    const det = parseSettleTx(byDigest[s.digest], pool);
    if (!byPool[pool]) {
      byPool[pool] = { pool: pool, digest: s.digest, amount: 0, burned: 0, quoteBought: 0 };
    }
    byPool[pool].amount += amount;
    byPool[pool].burned += det.burned || 0;
    byPool[pool].quoteBought += det.quoteBought || 0;
    if (!byPool[pool].digest && s.digest) byPool[pool].digest = s.digest;
  }
  return byPool;
}

async function withSettles(state, overlay, doChain) {
  if (overlay) applySettlesToBells(state.bells, overlay.byPool, overlay.byTicker);
  if (doChain) {
    const chain = await chainSettlesByPool();
    applySettlesToBells(state.bells, chain, null);
    overlay = overlayFrom(state, overlay);
    try {
      await saveJson(SETTLES_PATH, overlay);
    } catch (e) {}
  }
  return overlay;
}

function bellsNeedSettle(state) {
  return (state.bells || []).some(function (b) {
    return b && b.t && !b.skipped && (!(Number(b.amount) > 0) || !(Number(b.burned) > 0) || !b.digest);
  });
}

function sitoutExempt(t) {
  return SITOUT_EXEMPT.has(String(t || "").toUpperCase());
}

function bannedNow(banned, t, now) {
  t = String(t || "").toUpperCase();
  if (sitoutExempt(t)) return false;
  return (banned || []).some(function (b) {
    return String(b.t || "").toUpperCase() === t && Number(b.untilMs) > now;
  });
}

function applySitoutExempt(state) {
  if (!state) return false;
  const before = JSON.stringify(state.banned || []);
  const now = Date.now();
  state.banned = (state.banned || []).filter(function (b) {
    return Number(b.untilMs) > now && !sitoutExempt(b.t);
  });
  (state.standing || []).forEach(function (s) {
    s.banned = bannedNow(state.banned, s.t, now);
  });
  state.winner = pickWinner(state.standing || []);
  return JSON.stringify(state.banned || []) !== before;
}

function pickWinner(standing) {
  const eligible = standing.filter(function (s) {
    return !s.banned && Number(s.peakMcUsd) > 0;
  });
  eligible.sort(function (a, b) {
    return (b.peakMcUsd || 0) - (a.peakMcUsd || 0);
  });
  return eligible[0] || null;
}

async function refresh(prev) {
  const now = Date.now();
  const state = prev && prev.roundStartedMs ? Object.assign(emptyState(now), prev) : emptyState(now);
  state.mode = "buy-burn";
  state.banned = (state.banned || []).filter(function (b) {
    return Number(b.untilMs) > now && !sitoutExempt(b.t);
  });
  const [launches, px] = await Promise.all([listLaunches(), hopPrices()]);
  const pools = await Promise.all(launches.map(function (l) { return poolJson(l.pool); }));
  const prevStand = {};
  (state.standing || []).forEach(function (s) { prevStand[s.t] = s; });
  const standing = [];
  for (let i = 0; i < launches.length; i++) {
    const l = launches[i];
    const obj = pools[i];
    const qm = quoteMeta(l.quote);
    const usd = px[qm.label] || 0;
    const sqrt = obj && obj.json && (obj.json.current_sqrt_price || obj.json.current_sqrt_price_x64 || obj.json.sqrt_price);
    const mc = mcUsd(sqrt, 9, qm.dec, usd);
    const peak = Math.max(Number((prevStand[l.t] && prevStand[l.t].peakMcUsd) || 0), mc);
    standing.push({
      t: l.t,
      n: l.n,
      pool: l.pool,
      lock: l.lock,
      token: l.token,
      quote: qm.label,
      quoteType: l.quote,
      mcUsd: mc,
      peakMcUsd: peak,
      banned: bannedNow(state.banned, l.t, now),
    });
  }
  standing.sort(function (a, b) { return (b.peakMcUsd || 0) - (a.peakMcUsd || 0); });
  state.standing = standing;

  const ending = Number(state.roundEndMs || 0);
  if (now >= ending && Number(state.settledAtEnd || 0) !== ending) {
    const w = pickWinner(standing);
    if (w) {
      const last = (state.bells || [])[0];
      const dup = last && last.t === w.t && Math.abs(Number(last.ts) - now) < ROUND_MS;
      if (!dup) {
        state.bells = [{
          t: w.t,
          n: w.n,
          mcUsd: w.peakMcUsd,
          ts: now,
          mode: "buy-burn",
          pool: w.pool,
          lock: w.lock,
          token: w.token,
          quote: w.quote,
          quoteType: w.quoteType,
        }].concat(state.bells || []).slice(0, 12);
        const already = (state.banned || []).some(function (b) {
          return String(b.t).toUpperCase() === w.t && Number(b.untilMs) > now;
        });
        if (!already && !sitoutExempt(w.t)) {
          state.banned = (state.banned || []).concat([{ t: w.t, n: w.n, pool: w.pool, untilMs: now + COOLDOWN_MS }]);
        }
      }
    }
    standing.forEach(function (s) {
      s.peakMcUsd = s.mcUsd;
      s.banned = bannedNow(state.banned, s.t, now);
    });
    standing.sort(function (a, b) { return (b.peakMcUsd || 0) - (a.peakMcUsd || 0); });
    state.standing = standing;
    state.settledAtEnd = ending;
    state.round = Number(state.round || 0) + 1;
    state.roundStartedMs = now;
    state.roundEndMs = now + ROUND_MS;
  }

  state.winner = pickWinner(standing);
  state.updatedMs = now;
  state.quoteUsd = px;
  attachUsd(state, px);
  return state;
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  const prev = await loadBlob();
  let overlay = await loadSettles();
  const now = Date.now();
  const fresh = prev && now - Number(prev.updatedMs || 0) < 20000 && now < Number(prev.roundEndMs || 0);
  if (fresh) {
    const before = JSON.stringify((prev.bells || []).map(function (b) { return [b.amount, b.burned, b.digest]; }));
    overlay = (await withSettles(prev, overlay, false)) || overlay;
    if (bellsNeedSettle(prev)) {
      try {
        overlay = (await withSettles(prev, overlay, true)) || overlay;
      } catch (e) {}
    }
    const after = JSON.stringify((prev.bells || []).map(function (b) { return [b.amount, b.burned, b.digest]; }));
    const unbanned = applySitoutExempt(prev);
    attachUsd(prev, prev.quoteUsd);
    if (before !== after || unbanned) {
      prev.updatedMs = Date.now();
      try { await saveBlob(prev); } catch (e) {}
    }
    return json(prev, 200, request);
  }
  try {
    const state = await refresh(prev);
    if (prev && prev.bells) state.bells = mergeBells(state.bells, prev.bells);
    overlay = (await withSettles(state, overlay, false)) || overlay;
    if (bellsNeedSettle(state)) {
      try {
        overlay = (await withSettles(state, overlay, true)) || overlay;
      } catch (e) {}
    }
    applySitoutExempt(state);
    attachUsd(state, state.quoteUsd);
    try { await saveBlob(state); } catch (e) {}
    return json(state, 200, request);
  } catch (e) {
    if (prev) {
      try { await withSettles(prev, overlay, false); } catch (e2) {}
      applySitoutExempt(prev);
      return json(prev, 200, request);
    }
    const why = e && e.message ? String(e.message) : "pit-state failed";
    return json({ error: why.slice(0, 180) }, 502, request);
  }
}

export async function POST(request) {
  if (!settleAuth(request)) return json({ error: "unauthorized" }, 401, request);
  let body = {};
  try {
    body = await request.json();
  } catch (e) {
    return json({ error: "bad json" }, 400, request);
  }
  const ticker = String(body.ticker || body.t || "").toUpperCase();
  const digest = String(body.digest || "");
  const burned = body.burned != null ? Number(body.burned) : null;
  const amount = body.amount != null ? Number(body.amount) : null;
  const skipped = body.skipped ? String(body.skipped) : "";
  if (!ticker) return json({ error: "ticker required" }, 400, request);
  if (!digest && !skipped) return json({ error: "digest or skipped required" }, 400, request);
  const prev = await loadBlob();
  if (!prev) return json({ error: "no pit-state" }, 404, request);
  const bells = prev.bells || [];
  const hit = bells.find(function (b) {
    return String(b.t || "").toUpperCase() === ticker && !b.digest && !b.skipped;
  }) || bells.find(function (b) {
    return String(b.t || "").toUpperCase() === ticker;
  });
  if (!hit) return json({ error: "no bell for " + ticker }, 404, request);
  applySettleRow(hit, { digest: digest, skipped: skipped, burned: burned, amount: amount });
  hit.settledMs = Date.now();
  prev.updatedMs = Date.now();
  const overlay = overlayFrom(prev, await loadSettles());
  try {
    await saveJson(SETTLES_PATH, overlay);
    await saveBlob(prev);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "save failed";
    return json({ error: why.slice(0, 180) }, 502, request);
  }
  return json(prev, 200, request);
}
