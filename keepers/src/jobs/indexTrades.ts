/**
 * Instant trade indexer. Runs on Jessica Air.
 *
 * SQLite at keepers/data/trades.sqlite is the source of truth.
 * Each tick: discover Instadex pools, page Bluefin AssetSwap txs for those
 * pools only (never global AssetSwap), then POST the ticker snapshot to
 * /api/trades so the token-page tape can render full history.
 */
import { APP_URL, GQL, SUI, typeNameOf, USDY, XAGM, XAUM } from "../chain.ts";
import {
  burnMistForTicker,
  getMeta,
  insertBurn,
  insertTrade,
  listPools,
  setMeta,
  setPoolCursor,
  setPoolReserves,
  tickerByLock,
  tickers,
  tradeCount,
  tradesForTicker,
  upsertPool,
  type TradeRow,
} from "../tradesDb.ts";

const EVENT_PKG =
  process.env.ARENA_INSTADEX_PACKAGE ??
  "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3";
const LAUNCH_TYPE = `${EVENT_PKG}::events::InstadexLaunchEvent`;
const BLUEFIN_ASSET_SWAP =
  "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267::events::AssetSwap";
const PAGE_BUDGET = Number(process.env.ARENA_TRADES_PAGES || 48);
const BURN_PAGES = Number(process.env.ARENA_BURN_PAGES || 24);
const TX_PAGE = 50;
const BURN_TYPE =
  "0x47ea732e44f21470aa3dd449a7b26731ed2c377e2c02e650f3ede6ea581bf000::events::InstadexBurnEvent";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function padId(v: unknown): string {
  let s = String(v || "").toLowerCase().replace(/^0x/, "");
  if (!s || /[^0-9a-f]/.test(s)) return "";
  while (s.length < 64) s = "0" + s;
  return "0x" + s;
}

function quoteLabel(quote: string): string {
  const s = String(quote || "");
  if (!s || s === SUI || /::sui::SUI$/i.test(s)) return "SUI";
  if (s === "USDY" || s === USDY || /usdy/i.test(s)) return "USDY";
  if (s === "XAGM" || s === XAGM || /xagm/i.test(s)) return "XAGM";
  if (s === "XAUM" || s === XAUM || /xaum/i.test(s)) return "XAUM";
  return "SUI";
}

function mistStr(v: unknown): string {
  if (v == null) return "0";
  const s = String(v);
  return /^\d+$/.test(s) ? s : String(Math.max(0, Math.round(Number(s) || 0)));
}

async function gql(
  query: string,
  variables: Record<string, unknown>,
  tries = 6,
): Promise<Record<string, unknown> | null> {
  let last = "";
  for (let i = 0; i < tries; i++) {
    const r = await fetch(GQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const raw = await r.text();
    if (r.status === 429 || r.status >= 500) {
      last = "graphql " + r.status;
      await sleep(700 * (i + 1));
      continue;
    }
    let j: { data?: Record<string, unknown>; errors?: { message: string }[] } = {};
    try {
      j = raw ? JSON.parse(raw) : {};
    } catch {
      last = "graphql non-json " + r.status;
      await sleep(700 * (i + 1));
      continue;
    }
    if (j.errors?.length) throw new Error(j.errors[0].message || "graphql");
    return j.data || null;
  }
  throw new Error(last || "graphql retry");
}

async function discoverLaunches(): Promise<number> {
  let after: string | null = null;
  let n = 0;
  const q1 =
    "query($t:String!,$first:Int!){ events(first:$first, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }";
  const q2 =
    "query($t:String!,$first:Int!,$after:String!){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }";
  for (let page = 0; page < 16; page++) {
    const data = after
      ? await gql(q2, { t: LAUNCH_TYPE, first: 50, after })
      : await gql(q1, { t: LAUNCH_TYPE, first: 50 });
    const conn = (data && (data.events as { nodes?: { contents?: { json?: Record<string, unknown> } }[]; pageInfo?: { hasNextPage?: boolean; endCursor?: string } })) || {};
    const nodes = conn.nodes || [];
    for (const node of nodes) {
      const p = (node.contents && node.contents.json) || {};
      const ticker = String(p.symbol || "").toUpperCase().replace(/[^A-Z0-9_.\-]/g, "").slice(0, 16);
      const pool = padId(p.bluefin_pool_id);
      if (!ticker || !pool) continue;
      upsertPool({
        pool_id: pool,
        ticker,
        name: String(p.name || ticker),
        token: typeNameOf(p.token),
        quote: quoteLabel(typeNameOf(p.quote)),
        lock_id: padId(p.lock_id),
      });
      n++;
    }
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) break;
    after = conn.pageInfo.endCursor;
    await sleep(120);
  }
  return n;
}

type TxNode = {
  digest?: string;
  sender?: { address?: string };
  effects?: {
    timestamp?: string;
    events?: {
      nodes?: {
        timestamp?: string;
        contents?: { type?: { repr?: string }; json?: Record<string, unknown> };
      }[];
    };
  };
};

async function poolTxPage(poolId: string, before: string) {
  const q = before
    ? "query($o:SuiAddress!,$last:Int!,$before:String!){ transactions(last:$last, before:$before, filter:{ affectedObject:$o }){ pageInfo { hasPreviousPage startCursor } nodes { digest sender { address } effects { timestamp events(first: 40) { nodes { timestamp contents { type { repr } json } } } } } } }"
    : "query($o:SuiAddress!,$last:Int!){ transactions(last:$last, filter:{ affectedObject:$o }){ pageInfo { hasPreviousPage startCursor } nodes { digest sender { address } effects { timestamp events(first: 40) { nodes { timestamp contents { type { repr } json } } } } } } }";
  const vars: Record<string, unknown> = { o: poolId, last: TX_PAGE };
  if (before) vars.before = before;
  const data = await gql(q, vars);
  const conn =
    (data &&
      (data.transactions as {
        pageInfo?: { hasPreviousPage?: boolean; startCursor?: string };
        nodes?: TxNode[];
      })) ||
    {};
  return {
    nodes: conn.nodes || [],
    hasPrev: !!conn.pageInfo?.hasPreviousPage,
    cursor: conn.pageInfo?.startCursor || "",
  };
}

function parseSwap(node: TxNode, poolId: string, ticker: string): TradeRow | null {
  const effects = node.effects || {};
  const evs = (effects.events && effects.events.nodes) || [];
  const sender = (node.sender && node.sender.address) || "";
  const digest = String(node.digest || "");
  const ts0 = Date.parse(effects.timestamp || "") || 0;
  for (const e of evs) {
    const typ = (e.contents && e.contents.type && e.contents.type.repr) || "";
    if (typ !== BLUEFIN_ASSET_SWAP && !/::events::AssetSwap$/.test(typ)) continue;
    const p = (e.contents && e.contents.json) || {};
    const pid = padId(p.pool_id);
    if (pid && pid !== poolId) continue;
    const a2b = !!p.a2b;
    const isBuy = !a2b;
    const amountIn = mistStr(p.amount_in);
    const amountOut = mistStr(p.amount_out);
    const tokenAmt = isBuy ? amountOut : amountIn;
    const quoteAmt = isBuy ? amountIn : amountOut;
    const seq = mistStr(p.sequence_number);
    const ts = Date.parse(e.timestamp || "") || ts0 || Date.now();
    const id = `${digest}:${seq}:${poolId}`;
    return {
      id,
      pool_id: poolId,
      ticker,
      digest,
      seq,
      trader: sender,
      is_buy: isBuy ? 1 : 0,
      token_amount: tokenAmt,
      quote_amount: quoteAmt,
      token_reserve: mistStr(p.pool_coin_a_amount),
      quote_real: mistStr(p.pool_coin_b_amount),
      fee: mistStr(p.fee),
      ts,
    };
  }
  return null;
}

async function indexPool(
  pool: ReturnType<typeof listPools>[number],
  budget: { left: number },
  liveOnly: boolean,
): Promise<number> {
  let added = 0;
  let before = liveOnly ? "" : pool.cursor || "";
  const maxPages = liveOnly ? 1 : Math.max(1, budget.left);
  for (let i = 0; i < maxPages; i++) {
    if (budget.left <= 0) break;
    budget.left--;
    const page = await poolTxPage(pool.pool_id, before);
    for (const node of page.nodes) {
      const row = parseSwap(node, pool.pool_id, pool.ticker);
      if (row && insertTrade(row)) added++;
    }
    if (!page.hasPrev || !page.cursor) {
      setPoolCursor(pool.pool_id, "", true);
      return added;
    }
    before = page.cursor;
    if (!liveOnly) setPoolCursor(pool.pool_id, before, false);
    else if (!pool.cursor) setPoolCursor(pool.pool_id, before, false);
    await sleep(150);
  }
  return added;
}

function publicTrade(row: TradeRow) {
  return {
    id: row.id,
    pool_id: row.pool_id,
    ticker: row.ticker,
    digest: row.digest,
    seq: row.seq,
    trader: row.trader,
    is_buy: !!row.is_buy,
    quote_amount: row.quote_amount,
    token_amount: row.token_amount,
    token_reserve: row.token_reserve,
    quote_real: row.quote_real,
    raised: row.quote_real,
    fee: row.fee,
    ts: row.ts,
    timestampMs: row.ts,
    bluefin: true,
  };
}

async function publishTicker(ticker: string) {
  const secret = process.env.ARENA_SETTLE_SECRET || process.env.CRON_SECRET || "";
  if (!secret) return { ticker, skipped: "no CRON_SECRET" };
  const rows = tradesForTicker(ticker);
  const body = {
    ticker,
    count: rows.length,
    updatedMs: Date.now(),
    trades: rows.map(publicTrade),
  };
  const r = await fetch(`${APP_URL}/api/trades`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${secret}`,
    },
    body: JSON.stringify(body),
  });
  const raw = await r.text();
  let j: { error?: string; count?: number } = {};
  try {
    j = raw ? JSON.parse(raw) : {};
  } catch {
    j = { error: raw.slice(0, 120) };
  }
  if (!r.ok) throw new Error(j.error || `publish ${ticker} ${r.status}`);
  return { ticker, count: j.count ?? rows.length };
}

async function indexBurns(): Promise<number> {
  let added = 0;
  let after = getMeta("burns_cursor");
  const done = getMeta("burns_done") === "1";
  const max = done ? 2 : BURN_PAGES;
  const q1 =
    "query($t:String!,$first:Int!){ events(first:$first, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { timestamp contents { json } transaction { digest } } } }";
  const q2 =
    "query($t:String!,$first:Int!,$after:String!){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { timestamp contents { json } transaction { digest } } } }";
  for (let i = 0; i < max; i++) {
    const data =
      !done && after
        ? await gql(q2, { t: BURN_TYPE, first: 50, after })
        : await gql(q1, { t: BURN_TYPE, first: 50 });
    const conn =
      (data &&
        (data.events as {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          nodes?: {
            timestamp?: string;
            contents?: { json?: Record<string, unknown> };
            transaction?: { digest?: string };
          }[];
        })) ||
      {};
    const nodes = conn.nodes || [];
    for (const n of nodes) {
      const p = (n.contents && n.contents.json) || {};
      const lock = padId(p.lock_id);
      if (!lock) continue;
      const digest = String((n.transaction && n.transaction.digest) || "");
      const amount = mistStr(p.amount);
      const id = `${digest}:${lock}:${amount}`;
      const ticker = tickerByLock(lock);
      if (
        insertBurn({
          id,
          lock_id: lock,
          ticker,
          amount,
          digest,
          ts: Date.parse(n.timestamp || "") || 0,
        })
      ) {
        added++;
      }
    }
    if (done) break;
    if (!conn.pageInfo?.hasNextPage || !conn.pageInfo.endCursor) {
      setMeta("burns_done", "1");
      setMeta("burns_cursor", "");
      break;
    }
    after = conn.pageInfo.endCursor;
    setMeta("burns_cursor", after);
    await sleep(120);
  }
  return added;
}

async function snapshotPools(): Promise<number> {
  let n = 0;
  for (const pool of listPools()) {
    try {
      const data = await gql(
        "query($id:SuiAddress!){ object(address:$id){ asMoveObject { contents { json } } } }",
        { id: pool.pool_id },
      );
      const json =
        data &&
        (data.object as { asMoveObject?: { contents?: { json?: Record<string, unknown> } } })?.asMoveObject
          ?.contents?.json;
      if (!json) continue;
      const coinA = mistStr(json.coin_a);
      const coinB = mistStr(json.coin_b);
      if (coinA === "0" && coinB === "0") continue;
      setPoolReserves(pool.pool_id, coinA, coinB);
      n++;
    } catch {
      /* skip one pool */
    }
    await sleep(80);
  }
  return n;
}

async function hopUsd(): Promise<Record<string, number>> {
  try {
    const r = await fetch(`${APP_URL}/api/hop`);
    const j = (await r.json()) as Record<string, number>;
    return {
      SUI: Number(j.suiUsd) || 0,
      XAUM: Number(j.xaumUsd) || Number(j.usd) || 0,
      XAGM: Number(j.xagmUsd) || 0,
      USDY: Number(j.usdyUsd) || 1,
    };
  } catch {
    return { SUI: 0, XAUM: 0, XAGM: 0, USDY: 1 };
  }
}

function poolMcUsd(coinA: string, coinB: string, quote: string, hop: Record<string, number>): number {
  const a = Number(coinA) / 1e9;
  const qdec = quote === "USDY" ? 1e6 : 1e9;
  const b = Number(coinB) / qdec;
  const u = hop[quote] || 0;
  if (!(a > 0) || !(b > 0) || !(u > 0)) return 0;
  return (b / a) * 1e9 * u;
}

async function publishStats() {
  const secret = process.env.ARENA_SETTLE_SECRET || process.env.CRON_SECRET || "";
  if (!secret) return { skipped: "no CRON_SECRET" };
  const hop = await hopUsd();
  const out = [];
  const byTicker = new Map<string, ReturnType<typeof listPools>>();
  for (const p of listPools()) {
    const rows = byTicker.get(p.ticker) || [];
    rows.push(p);
    byTicker.set(p.ticker, rows);
  }
  for (const [ticker, rows] of byTicker) {
    const pool = rows[0];
    const burned = burnMistForTicker(ticker);
    const mcUsd = poolMcUsd(pool.coin_a || "0", pool.coin_b || "0", pool.quote || "SUI", hop);
    const body = {
      ticker,
      burned,
      coinA: pool.coin_a || "0",
      coinB: pool.coin_b || "0",
      quote: pool.quote || "SUI",
      pool: pool.pool_id,
      lock: pool.lock_id,
      mcUsd,
      updatedMs: Date.now(),
    };
    try {
      const r = await fetch(`${APP_URL}/api/token-stats`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${secret}`,
        },
        body: JSON.stringify(body),
      });
      const raw = await r.text();
      let j: { error?: string } = {};
      try {
        j = raw ? JSON.parse(raw) : {};
      } catch {
        j = { error: raw.slice(0, 120) };
      }
      if (!r.ok) throw new Error(j.error || `stats ${ticker} ${r.status}`);
      out.push({ ticker, burned, mcUsd });
    } catch (e) {
      out.push({ ticker, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return out;
}

export async function runIndexTrades() {
  const discovered = await discoverLaunches();
  const burnedNew = await indexBurns();
  const snapped = await snapshotPools();
  const pools = listPools();
  const budget = { left: PAGE_BUDGET };
  const dirty = new Set<string>();
  let inserted = 0;

  const unfinished = listPools().filter((p) => !p.backfill_done);
  if (unfinished.length) {
    for (const pool of unfinished) {
      if (budget.left <= 0) break;
      const n = await indexPool(pool, budget, false);
      inserted += n;
      dirty.add(pool.ticker);
    }
  } else {
    for (const pool of pools) {
      if (budget.left <= 0) break;
      const n = await indexPool(pool, budget, true);
      if (n > 0) dirty.add(pool.ticker);
      inserted += n;
    }
  }

  const published = [];
  const toPublish = dirty.size ? [...dirty] : tickers();
  for (const t of toPublish) {
    try {
      published.push(await publishTicker(t));
    } catch (e) {
      published.push({ ticker: t, error: e instanceof Error ? e.message : String(e) });
    }
  }

  let stats: unknown = [];
  try {
    stats = await publishStats();
  } catch (e) {
    stats = { error: e instanceof Error ? e.message : String(e) };
  }

  return {
    discovered,
    pools: pools.length,
    inserted,
    total: tradeCount(),
    burnedNew,
    snapped,
    backfillLeft: listPools().filter((p) => !p.backfill_done).length,
    published,
    stats,
  };
}
