/**
 * Fight Night standing. Runs on Jessica Air.
 * GraphQL + Bluefin sqrt MC live here; Vercel GET /api/pit-state only reads the blob.
 */
import { APP_URL, GQL, typeNameOf, USDY, XAGM, XAUM } from "../chain.ts";

const EVENT_PKG =
  process.env.ARENA_INSTADEX_PACKAGE ||
  "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3";
const ROUND_MS = 86_400_000;
const COOLDOWN_MS = 172_800_000;
const SUPPLY = 1e9;
const Q64 = 2 ** 64;
const HIDE = new Set(["BFLN", "GRAD", "SMOKE", "IDEX", "SILVER"]);
const SITOUT_EXEMPT = new Set(["GOLDY"]);

type PitState = Record<string, unknown> & {
  round?: number;
  roundStartedMs?: number;
  roundEndMs?: number;
  settledAtEnd?: number;
  winner?: Standing | null;
  banned?: { t: string; n?: string; pool?: string; untilMs: number }[];
  bells?: Record<string, unknown>[];
  standing?: Standing[];
  mode?: string;
  updatedMs?: number;
  quoteUsd?: Record<string, number>;
};

type Standing = {
  t: string;
  n: string;
  pool: string;
  lock: string;
  token: string;
  quote: string;
  quoteType: string;
  mcUsd: number;
  peakMcUsd: number;
  banned: boolean;
};

function asId(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v.startsWith("0x") ? v : "0x" + v;
  if (typeof v === "object" && v && "id" in v) return asId((v as { id: unknown }).id);
  return String(v);
}

function tickerOf(sym: unknown, token: unknown): string {
  const s = String(sym || "").toUpperCase();
  if (s) return s.replace(/[^A-Z0-9_.\-]/g, "").slice(0, 16);
  const t = typeNameOf(token);
  const i = t.lastIndexOf("::");
  return (i >= 0 ? t.slice(i + 2) : t).toUpperCase().slice(0, 16);
}

function hiddenLaunch(t: string, n: string) {
  if (HIDE.has(t)) return true;
  return /^Arena (Bluefin|Grad|Smoke)$/i.test(n || "") || /^INSTA$/i.test(n || "");
}

function quoteMeta(type: string) {
  const s = String(type || "");
  if (/usdy/i.test(s) || s === USDY) return { label: "USDY", dec: 6 };
  if (/xagm/i.test(s) || s === XAGM) return { label: "XAGM", dec: 9 };
  if (/xaum/i.test(s) || s === XAUM) return { label: "XAUM", dec: 9 };
  return { label: "SUI", dec: 9 };
}

function sitoutExempt(t: string) {
  return SITOUT_EXEMPT.has(String(t || "").toUpperCase());
}

function bannedNow(banned: PitState["banned"], t: string, now: number) {
  t = String(t || "").toUpperCase();
  if (sitoutExempt(t)) return false;
  return (banned || []).some((b) => String(b.t || "").toUpperCase() === t && Number(b.untilMs) > now);
}

function mcUsd(sqrt: unknown, decA: number, decB: number, quoteUsd: number) {
  const s = Number(typeof sqrt === "object" && sqrt ? (sqrt as { value?: unknown }).value : sqrt);
  if (!(s > 0) || !(quoteUsd > 0)) return 0;
  const raw = (s / Q64) * (s / Q64);
  const px = raw * Math.pow(10, decA - decB);
  if (!(px > 0) || !isFinite(px)) return 0;
  const n = px * SUPPLY * quoteUsd;
  if (!(n > 0) || n > 1e10) return 0;
  return n;
}

async function gql(query: string, variables: Record<string, unknown>) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error("graphql " + r.status);
  const j = raw ? JSON.parse(raw) : {};
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql");
  return j.data;
}

async function hopPrices(): Promise<Record<string, number>> {
  const [suiUsdc, suiRes, usdy, xagm, xaum] = await Promise.all([
    fetch("https://api.dexpaprika.com/networks/sui/pools/0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab").then((r) => r.json()).catch(() => null),
    fetch("https://api.coingecko.com/api/v3/simple/price?ids=sui&vs_currencies=usd").catch(() => null),
    fetch("https://api.dexpaprika.com/networks/sui/pools/0xdcd762ad374686fa890fc4f3b9bbfe2a244e713d7bffbfbd1b9221cb290da2ed").then((r) => r.json()).catch(() => null),
    fetch("https://api.dexpaprika.com/networks/sui/pools/0x4d3cc875e334440ad3485d4455d7ee072ea01b18c526ad64f9ebe2aa0a4f01b9").then((r) => r.json()).catch(() => null),
    fetch("https://api.dexpaprika.com/networks/sui/pools/0x458fc3722cc88babd7cbe78273aa5e4ecbdff75c76a2ad14cd1f75418b569649").then((r) => r.json()).catch(() => null),
  ]);
  let suiUsd = Number((suiUsdc && (suiUsdc.last_price_usd || suiUsdc.last_price)) || 0);
  try {
    if (!(suiUsd > 0) && suiRes && "ok" in suiRes && suiRes.ok) {
      const g = await (suiRes as Response).json();
      suiUsd = Number(g && g.sui && g.sui.usd) || 0;
    }
  } catch {
    /* skip */
  }
  return {
    SUI: suiUsd,
    USDY: Number((usdy && (usdy.last_price_usd || usdy.last_price)) || 0) || 1,
    XAGM: Number((xagm && (xagm.last_price_usd || xagm.last_price)) || 0),
    XAUM: Number((xaum && (xaum.last_price_usd || xaum.last_price)) || 0),
  };
}

async function listLaunches() {
  const type = EVENT_PKG + "::events::InstadexLaunchEvent";
  const q =
    "query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }";
  const out: { t: string; n: string; pool: string; lock: string; token: string; quote: string }[] = [];
  let after: string | null = null;
  for (let i = 0; i < 6; i++) {
    const data = await gql(q, { t: type, first: 50, after });
    const nodes = (data && data.events && data.events.nodes) || [];
    for (const n of nodes) {
      const p = (n.contents && n.contents.json) || {};
      const t = tickerOf(p.symbol, p.token);
      const name = String(p.name || t);
      if (!t || hiddenLaunch(t, name)) continue;
      out.push({
        t,
        n: name,
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
  const seen: Record<string, number> = {};
  const uniq = [];
  for (const row of out) {
    if (seen[row.t]) continue;
    seen[row.t] = 1;
    uniq.push(row);
  }
  return uniq;
}

async function poolJson(id: string) {
  if (!id) return null;
  try {
    const data = await gql(
      "query($id:SuiAddress!){ object(address:$id){ asMoveObject { contents { type { repr } json } } } }",
      { id },
    );
    const c = data && data.object && data.object.asMoveObject && data.object.asMoveObject.contents;
    return c && c.json ? { json: c.json } : null;
  } catch {
    return null;
  }
}

function emptyState(now: number): PitState {
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

function pickWinner(standing: Standing[]) {
  const eligible = standing.filter((s) => !s.banned && Number(s.peakMcUsd) > 0);
  eligible.sort((a, b) => (b.peakMcUsd || 0) - (a.peakMcUsd || 0));
  return eligible[0] || null;
}

function attachUsd(state: PitState, px: Record<string, number>) {
  (state.bells || []).forEach((b) => {
    const raw = Number(b && b.amount);
    if (!(raw > 0)) return;
    const n = raw >= 1e7 ? raw / 1e9 : raw;
    const u = (px && px.SUI) || 0;
    if (n > 0 && u > 0) b.amountUsd = n * u;
  });
}

async function loadPrev(): Promise<PitState | null> {
  try {
    const r = await fetch(`${APP_URL}/api/pit-state`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    if (!j || j.error) return null;
    return j as PitState;
  } catch {
    return null;
  }
}

async function refresh(prev: PitState | null): Promise<PitState> {
  const now = Date.now();
  const state: PitState = prev ? { ...emptyState(now), ...prev } : emptyState(now);
  if (!state.roundStartedMs) state.roundStartedMs = now;
  if (!state.roundEndMs) state.roundEndMs = now + ROUND_MS;
  state.mode = "buy-burn";
  state.banned = (state.banned || []).filter((b) => Number(b.untilMs) > now && !sitoutExempt(b.t));
  const [launches, px] = await Promise.all([listLaunches(), hopPrices()]);
  const pools = await Promise.all(launches.map((l) => poolJson(l.pool)));
  const prevStand: Record<string, Standing> = {};
  (state.standing || []).forEach((s) => {
    prevStand[s.t] = s;
  });
  const standing: Standing[] = [];
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
  standing.sort((a, b) => (b.peakMcUsd || 0) - (a.peakMcUsd || 0));
  state.standing = standing;

  const ending = Number(state.roundEndMs || 0);
  if (now >= ending && Number(state.settledAtEnd || 0) !== ending) {
    const w = pickWinner(standing);
    if (w) {
      const last = (state.bells || [])[0] as { t?: string; ts?: number } | undefined;
      const dup = last && last.t === w.t && Math.abs(Number(last.ts) - now) < ROUND_MS;
      if (!dup) {
        state.bells = [
          {
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
          },
        ].concat(state.bells || []).slice(0, 12);
        const already = (state.banned || []).some((b) => String(b.t).toUpperCase() === w.t && Number(b.untilMs) > now);
        if (!already && !sitoutExempt(w.t)) {
          state.banned = (state.banned || []).concat([{ t: w.t, n: w.n, pool: w.pool, untilMs: now + COOLDOWN_MS }]);
        }
      }
    }
    standing.forEach((s) => {
      s.peakMcUsd = s.mcUsd;
      s.banned = bannedNow(state.banned, s.t, now);
    });
    standing.sort((a, b) => (b.peakMcUsd || 0) - (a.peakMcUsd || 0));
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

async function publish(state: PitState) {
  const secret = process.env.ARENA_SETTLE_SECRET || process.env.CRON_SECRET || "";
  if (!secret) throw new Error("no CRON_SECRET");
  const r = await fetch(`${APP_URL}/api/pit-state`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify({ state }),
  });
  const raw = await r.text();
  let j: { error?: string } = {};
  try {
    j = raw ? JSON.parse(raw) : {};
  } catch {
    j = { error: raw.slice(0, 120) };
  }
  if (!r.ok) throw new Error(j.error || "pit-state POST " + r.status);
  return j;
}

export async function runRefreshPitState() {
  const prev = await loadPrev();
  const state = await refresh(prev);
  const saved = await publish(state);
  return {
    round: state.round,
    standing: (state.standing || []).length,
    winner: state.winner && state.winner.t,
    bells: (state.bells || []).length,
    updatedMs: state.updatedMs,
    saved: !!(saved && !saved.error),
  };
}
