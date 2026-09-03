import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const PATH = process.env.ARENA_TRADES_DB || join(ROOT, "data", "trades.sqlite");

export type PoolRow = {
  pool_id: string;
  ticker: string;
  name: string;
  token: string;
  quote: string;
  lock_id: string;
  cursor: string;
  backfill_done: number;
  updated_ms: number;
};

export type TradeRow = {
  id: string;
  pool_id: string;
  ticker: string;
  digest: string;
  seq: string;
  trader: string;
  is_buy: number;
  token_amount: string;
  quote_amount: string;
  token_reserve: string;
  quote_real: string;
  fee: string;
  ts: number;
};

let db: DatabaseSync | null = null;

export function tradesDb(): DatabaseSync {
  if (db) return db;
  mkdirSync(dirname(PATH), { recursive: true });
  db = new DatabaseSync(PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS pools (
      pool_id TEXT PRIMARY KEY,
      ticker TEXT NOT NULL,
      name TEXT DEFAULT '',
      token TEXT DEFAULT '',
      quote TEXT DEFAULT '',
      lock_id TEXT DEFAULT '',
      cursor TEXT DEFAULT '',
      backfill_done INTEGER NOT NULL DEFAULT 0,
      updated_ms INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS trades (
      id TEXT PRIMARY KEY,
      pool_id TEXT NOT NULL,
      ticker TEXT NOT NULL,
      digest TEXT DEFAULT '',
      seq TEXT DEFAULT '',
      trader TEXT DEFAULT '',
      is_buy INTEGER NOT NULL,
      token_amount TEXT DEFAULT '0',
      quote_amount TEXT DEFAULT '0',
      token_reserve TEXT DEFAULT '0',
      quote_real TEXT DEFAULT '0',
      fee TEXT DEFAULT '0',
      ts INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS trades_ticker_ts ON trades(ticker, ts DESC);
    CREATE INDEX IF NOT EXISTS trades_pool_ts ON trades(pool_id, ts DESC);
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  return db;
}

export function upsertPool(row: {
  pool_id: string;
  ticker: string;
  name?: string;
  token?: string;
  quote?: string;
  lock_id?: string;
}) {
  const d = tradesDb();
  d.prepare(
    `INSERT INTO pools (pool_id, ticker, name, token, quote, lock_id, updated_ms)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(pool_id) DO UPDATE SET
       ticker=excluded.ticker,
       name=CASE WHEN excluded.name != '' THEN excluded.name ELSE pools.name END,
       token=CASE WHEN excluded.token != '' THEN excluded.token ELSE pools.token END,
       quote=CASE WHEN excluded.quote != '' THEN excluded.quote ELSE pools.quote END,
       lock_id=CASE WHEN excluded.lock_id != '' THEN excluded.lock_id ELSE pools.lock_id END,
       updated_ms=excluded.updated_ms`,
  ).run(
    row.pool_id,
    row.ticker,
    row.name || "",
    row.token || "",
    row.quote || "",
    row.lock_id || "",
    Date.now(),
  );
}

export function listPools(): PoolRow[] {
  return tradesDb()
    .prepare(
      `SELECT pool_id, ticker, name, token, quote, lock_id, cursor, backfill_done, updated_ms
       FROM pools ORDER BY ticker ASC`,
    )
    .all() as PoolRow[];
}

export function setPoolCursor(poolId: string, cursor: string, backfillDone: boolean) {
  tradesDb()
    .prepare(`UPDATE pools SET cursor=?, backfill_done=?, updated_ms=? WHERE pool_id=?`)
    .run(cursor || "", backfillDone ? 1 : 0, Date.now(), poolId);
}

export function insertTrade(row: TradeRow): boolean {
  const r = tradesDb()
    .prepare(
      `INSERT OR IGNORE INTO trades
        (id, pool_id, ticker, digest, seq, trader, is_buy, token_amount, quote_amount, token_reserve, quote_real, fee, ts)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      row.id,
      row.pool_id,
      row.ticker,
      row.digest,
      row.seq,
      row.trader,
      row.is_buy,
      row.token_amount,
      row.quote_amount,
      row.token_reserve,
      row.quote_real,
      row.fee,
      row.ts,
    );
  return Number(r.changes || 0) > 0;
}

export function tradesForTicker(ticker: string, poolId?: string): TradeRow[] {
  const d = tradesDb();
  if (poolId) {
    return d
      .prepare(
        `SELECT * FROM trades WHERE ticker=? AND pool_id=? ORDER BY ts DESC, seq DESC`,
      )
      .all(ticker, poolId) as TradeRow[];
  }
  return d.prepare(`SELECT * FROM trades WHERE ticker=? ORDER BY ts DESC, seq DESC`).all(ticker) as TradeRow[];
}

export function tradeCount(ticker?: string): number {
  const d = tradesDb();
  if (ticker) {
    const row = d.prepare(`SELECT COUNT(*) AS n FROM trades WHERE ticker=?`).get(ticker) as { n: number };
    return Number(row?.n || 0);
  }
  const row = d.prepare(`SELECT COUNT(*) AS n FROM trades`).get() as { n: number };
  return Number(row?.n || 0);
}

export function tickers(): string[] {
  return (tradesDb().prepare(`SELECT DISTINCT ticker FROM pools ORDER BY ticker`).all() as { ticker: string }[]).map(
    (r) => r.ticker,
  );
}

export function closeTradesDb() {
  if (db) {
    db.close();
    db = null;
  }
}
