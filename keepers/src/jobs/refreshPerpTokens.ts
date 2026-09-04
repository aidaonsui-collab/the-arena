/**
 * AMC vault NAV + optional AMC-USDC market buy. Runs on Jessica Air.
 * Vercel GET /api/perp-tokens is blob-only.
 * Set ARENA_PERP_TRADE=1 to place longs when a Vice vault has idle USDC and no AMC book.
 */
import { Transaction } from "@mysten/sui/transactions";
import { fromBase64 } from "@mysten/sui/utils";
import { APP_URL } from "../chain.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";

const AF = "https://aftermath.finance/api/perpetuals";
const AMC_MARKET =
  process.env.ARENA_AMC_MARKET ||
  "0x8d7bfd380f89e0998a0d71cf46615948f4f2fab3d3904fe8a522c50a8cb0f3df";
const PLATFORM = (
  process.env.ARENA_KEEPER_ADDRESS ||
  "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b"
).toLowerCase();
const TARGET_LEV = Number(process.env.ARENA_PERP_LEVERAGE || 2);
const MIN_IDLE_USD = 1;

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

function nStr(v: unknown): number {
  if (typeof v === "number") return v;
  const s = String(v ?? "").replace(/n$/i, "");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

function asAddr(v: unknown): string {
  return String(v || "").toLowerCase();
}

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

async function execKind(txKind: string) {
  if (!txKind) throw new Error("no txKind");
  const kp = loadSigner();
  const tx = Transaction.fromKind(fromBase64(txKind));
  tx.setSender(kp.getPublicKey().toSuiAddress());
  const sent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
  });
  const status = sent.effects?.status?.status;
  if (status && status !== "success") throw new Error("tx " + status);
  return sent.digest;
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

async function loadMarket() {
  const j = await afPost("/markets", { marketIds: [AMC_MARKET] });
  const datas = (j.marketDatas || []) as Record<string, unknown>[];
  const row = datas[0] || {};
  const params = (row.marketParams || {}) as Record<string, unknown>;
  const px = Number(row.indexPrice) || 0;
  return {
    lotSize: Math.max(1, nStr(params.lotSize) || 10000),
    scale: Number(params.scalingFactor) || 1e-6,
    minUsd: Number(params.minOrderUsdValue) || 1,
    px,
    imr: Number(params.marginRatioInitial) || 0.2,
  };
}

async function loadVault(vaultId: string) {
  const j = await afPost("/vaults", { vaultIds: [vaultId] });
  const vaults = (j.vaults || []) as Record<string, unknown>[];
  return vaults[0] || null;
}

async function loadPositions(accountId: unknown) {
  const id = String(accountId || "");
  if (!id) return [];
  const j = await afPost("/accounts/positions", { accountIds: [id] });
  const accounts = (j.accounts || []) as { positions?: { marketId?: string; baseAssetAmount?: unknown }[] }[];
  return accounts[0]?.positions || [];
}

function sizeFor(idleUsd: number, px: number, lot: number, scale: number, minUsd: number, lev: number) {
  const collat = idleUsd * 0.9;
  const notional = collat * lev;
  if (!(px > 0) || !(scale > 0) || notional < minUsd) return { size: 0, notional: 0, collat };
  const raw = notional / px / scale;
  const size = Math.floor(raw / lot) * lot;
  const usd = size * scale * px;
  if (size < lot || usd < minUsd) return { size: 0, notional: usd, collat };
  return { size, notional: usd, collat };
}

async function maybeTrade(vault: Record<string, unknown>, mkt: Awaited<ReturnType<typeof loadMarket>>) {
  const vaultId = String(vault.objectId || "");
  const owner = asAddr(vault.ownerAddress);
  if (!vaultId || owner !== PLATFORM) return { skipped: true, reason: "not Vice-owned" };
  const idleUsd = Number(vault.idleCollateralUsd) || nStr(vault.idleCollateral) / 1e6;
  if (idleUsd < MIN_IDLE_USD) return { skipped: true, reason: "idle under $1", idleUsd };
  const positions = await loadPositions(vault.accountId);
  const amcPos = positions.find((p) => String(p.marketId || "").toLowerCase() === AMC_MARKET);
  if (amcPos && nStr(amcPos.baseAssetAmount) !== 0) {
    return { skipped: true, reason: "already in AMC", size: nStr(amcPos.baseAssetAmount) };
  }
  const lev = Math.min(5, Math.max(1, TARGET_LEV || 2));
  const plan = sizeFor(idleUsd, mkt.px, mkt.lotSize, mkt.scale, mkt.minUsd, lev);
  if (!(plan.size > 0)) return { skipped: true, reason: "size below min", idleUsd, px: mkt.px };
  const walletAddress = loadSigner().getPublicKey().toSuiAddress();
  const built = await afPost("/vault/transactions/place-market-order", {
    vaultId,
    walletAddress,
    marketId: AMC_MARKET,
    side: 0,
    size: String(plan.size) + "n",
    collateralChange: plan.collat,
    hasPosition: false,
    reduceOnly: false,
    cancelSlTp: false,
    slippage: 0.02,
    leverage: lev,
  });
  const digest = await execKind(String(built.txKind || ""));
  return {
    traded: true,
    digest,
    size: plan.size,
    notional: plan.notional,
    collat: plan.collat,
    lev,
  };
}

async function maybeWithdraws(vaultId: string) {
  const j = await afPost("/vaults/withdraw-requests", { vaultIds: [vaultId] });
  const reqs = (j.withdrawRequests || []) as { userAddress?: string; vaultId?: string }[];
  const mine = reqs.filter((r) => String(r.vaultId || "").toLowerCase() === vaultId.toLowerCase());
  const users = [...new Set(mine.map((r) => r.userAddress).filter(Boolean))] as string[];
  if (!users.length) return { skipped: true, reason: "no withdraws" };
  const walletAddress = loadSigner().getPublicKey().toSuiAddress();
  const built = await afPost("/vault/transactions/owner/process-withdraw-requests", {
    vaultId,
    walletAddress,
    userAddresses: users,
  });
  const digest = await execKind(String(built.txKind || ""));
  return { processed: true, digest, users: users.length };
}

export async function runRefreshPerpTokens() {
  const tokens = await loadCatalog();
  const live = tokens.filter((t) => t && t.ticker && t.vaultId);
  const tradeOn = process.env.ARENA_PERP_TRADE === "1";
  let mkt: Awaited<ReturnType<typeof loadMarket>> | null = null;
  try {
    mkt = await loadMarket();
  } catch {
    mkt = null;
  }
  const amcPx = mkt?.px || 0;

  const out = [];
  for (const t of live) {
    const vaultId = String(t.vaultId || "");
    let vault: Record<string, unknown> | null = null;
    try {
      vault = await loadVault(vaultId);
    } catch {
      vault = null;
    }
    const tvlUsd = vault ? Number(vault.tvlUsd) || 0 : Number(t.tvlUsd) || 0;
    const idleUsd = vault ? Number(vault.idleCollateralUsd) || 0 : 0;
    const positions = vault ? await loadPositions(vault.accountId).catch(() => []) : [];
    const amcPos = positions.find((p) => String(p.marketId || "").toLowerCase() === AMC_MARKET);
    const posSize = amcPos ? String(amcPos.baseAssetAmount || "0") : "0";
    let trade: unknown = { skipped: true, reason: "trade off" };
    let withdraw: unknown = { skipped: true, reason: "no vault" };
    if (vault && tradeOn) {
      try {
        trade = await maybeTrade(vault, mkt || (await loadMarket()));
      } catch (e) {
        trade = { error: e instanceof Error ? e.message : String(e) };
      }
    } else if (vault && !tradeOn) {
      trade = { skipped: true, reason: "ARENA_PERP_TRADE off" };
    }
    if (vault) {
      try {
        withdraw = await maybeWithdraws(vaultId);
      } catch (e) {
        withdraw = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const row = {
      ticker: t.ticker,
      vaultId,
      lpCoinType: t.lpCoinType || String(vault?.lpCoinType || ""),
      navUsd: tvlUsd,
      tvlUsd,
      amcPx,
      leverage: TARGET_LEV,
      posSize,
      pending: false,
    };
    await publish(row);
    out.push({ ticker: t.ticker, tvlUsd, idleUsd, posSize, trade, withdraw });
  }

  return {
    scanned: tokens.length,
    live: live.length,
    pending: tokens.filter((t) => t.pending && !t.vaultId).length,
    amcMarket: AMC_MARKET,
    amcPx,
    trade: tradeOn,
    rows: out,
  };
}
