/**
 * AMC vault NAV. Runs on Jessica Air.
 * Vercel GET /api/perp-tokens is blob-only. Do not place AMC orders unless ARENA_PERP_TRADE=1.
 */
import { APP_URL } from "../chain.ts";

const AF = "https://aftermath.finance/api/perpetuals";
const AMC_MARKET =
  process.env.ARENA_AMC_MARKET ||
  "0x8d7bfd380f89e0998a0d71cf46615948f4f2fab3d3904fe8a522c50a8cb0f3df";

type PerpToken = {
  ticker: string;
  name?: string;
  vaultId?: string;
  lpCoinType?: string;
  pending?: boolean;
  navUsd?: number;
  tvlUsd?: number;
  amcPx?: number;
  leverage?: number;
  posSize?: string;
};

async function afPost(path: string, body: Record<string, unknown>) {
  const r = await fetch(AF + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let j: Record<string, unknown> = {};
  try {
    j = raw ? JSON.parse(raw) : {};
  } catch {
    j = { error: raw.slice(0, 180) };
  }
  if (!r.ok) throw new Error(String(j.error || raw.slice(0, 180) || r.status));
  return j;
}

async function loadCatalog(): Promise<PerpToken[]> {
  const r = await fetch(`${APP_URL}/api/perp-tokens`, { cache: "no-store" });
  if (!r.ok) return [];
  const j = await r.json();
  return Array.isArray(j && j.tokens) ? j.tokens : [];
}

async function publish(row: PerpToken) {
  const secret = process.env.ARENA_SETTLE_SECRET || process.env.CRON_SECRET || "";
  if (!secret) throw new Error("no CRON_SECRET");
  const r = await fetch(`${APP_URL}/api/perp-tokens`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(row),
  });
  const raw = await r.text();
  let j: { error?: string } = {};
  try {
    j = raw ? JSON.parse(raw) : {};
  } catch {
    j = { error: raw.slice(0, 120) };
  }
  if (!r.ok) throw new Error(j.error || "perp-tokens POST " + r.status);
  return j;
}

export async function runRefreshPerpTokens() {
  const tokens = await loadCatalog();
  const live = tokens.filter((t) => t && t.ticker && t.vaultId);
  const vaultIds = live.map((t) => t.vaultId as string);
  let prices: { priceInCollateral?: number; priceUsd?: number }[] = [];
  let amcPx = 0;
  if (vaultIds.length) {
    try {
      const px = await afPost("/vaults/lp-coin-prices", { vaultIds });
      const arr = (px.lpCoinPrices || px.prices || []) as { priceInCollateral?: number; priceUsd?: number }[];
      prices = Array.isArray(arr) ? arr : [];
    } catch {
      prices = [];
    }
    try {
      const mk = await afPost("/markets/prices", { marketIds: [AMC_MARKET] });
      const rows = (mk.prices || mk.marketPrices || []) as { indexPrice?: number; price?: number }[];
      const first = rows[0] || {};
      amcPx = Number(first.indexPrice || first.price) || 0;
    } catch {
      amcPx = 0;
    }
  }

  const out = [];
  for (let i = 0; i < live.length; i++) {
    const t = live[i];
    const p = prices[i] || {};
    const nav = Number(p.priceUsd || p.priceInCollateral) || 0;
    const row = {
      ticker: t.ticker,
      vaultId: t.vaultId,
      lpCoinType: t.lpCoinType,
      navUsd: nav,
      tvlUsd: nav,
      amcPx,
      pending: false,
    };
    await publish(row);
    out.push({ ticker: t.ticker, navUsd: nav, vaultId: t.vaultId });
  }

  return {
    scanned: tokens.length,
    live: live.length,
    pending: tokens.filter((t) => t.pending && !t.vaultId).length,
    amcMarket: AMC_MARKET,
    trade: process.env.ARENA_PERP_TRADE === "1",
    rows: out,
  };
}
