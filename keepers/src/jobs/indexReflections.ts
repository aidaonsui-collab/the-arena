/**
 * Reflection keeper.
 *
 * On-chain: every fill on a reflection pool already takes 2% of quote (after the 1% pit)
 * and accrues it via magnified dividends. Holders call `pool::claim_reflection`.
 *
 * This job is the off-chain half:
 *   1. Ingest TradeEvent (reflection_fee) and ClaimEvent (kind=0)
 *   2. Keep a per-pool, per-address unpaid/claimed snapshot for the UI
 *   3. Do NOT push payouts (Sui Tables are not iterable; claims stay user-initiated)
 *
 * Cursor is written to KEEPERS_CURSOR_PATH (default ./data/reflections.json).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CLAIM_REFLECTION } from "../config.ts";
import { claimEventType, queryEvents, tradeEventType } from "../sui.ts";
import type { ClaimEvent, ReflectionIndex, TradeEvent } from "../types.ts";

const PATH = process.env.KEEPERS_CURSOR_PATH ?? "./data/reflections.json";

async function load(): Promise<ReflectionIndex> {
  try {
    return JSON.parse(await readFile(PATH, "utf8")) as ReflectionIndex;
  } catch {
    return { pools: {}, cursor: null };
  }
}

async function save(idx: ReflectionIndex) {
  await mkdir(dirname(PATH), { recursive: true });
  await writeFile(PATH, JSON.stringify(idx, null, 2));
}

function pool(idx: ReflectionIndex, poolId: string) {
  if (!idx.pools[poolId]) {
    idx.pools[poolId] = {
      quote: "SUI",
      reflection: true,
      holders: {},
      totalReflectionFees: "0",
      totalClaimed: "0",
    };
  }
  return idx.pools[poolId];
}

function holder(p: ReflectionIndex["pools"][string], poolId: string, address: string) {
  if (!p.holders[address]) {
    p.holders[address] = {
      poolId,
      address,
      registered: "0",
      unpaidReflection: "0",
      claimedReflection: "0",
      updatedMs: Date.now(),
    };
  }
  return p.holders[address];
}

function add(a: string, b: string) {
  return (BigInt(a) + BigInt(b)).toString();
}

function sub(a: string, b: string) {
  const n = BigInt(a) - BigInt(b);
  return (n < 0n ? 0n : n).toString();
}

export async function runIndexReflections() {
  const idx = await load();
  let cursor = idx.cursor;
  let pages = 0;

  // Trades first so unpaid is current before claims in the same page window.
  while (pages < 20) {
    const page = await queryEvents(tradeEventType(), cursor);
    if (!page.data.length) break;
    for (const ev of page.data) {
      const p = ev.parsedJson as TradeEvent;
      if (!p?.pool_id) continue;
      const fee = p.reflection_fee ?? "0";
      if (fee === "0") continue;
      const rec = pool(idx, p.pool_id);
      rec.totalReflectionFees = add(rec.totalReflectionFees, fee);
      const h = holder(rec, p.pool_id, p.trader);
      h.unpaidReflection = add(h.unpaidReflection, fee);
      h.registered = p.is_buy
        ? add(h.registered, p.token_amount)
        : sub(h.registered, p.token_amount);
      h.updatedMs = Date.now();
    }
    cursor = (page.nextCursor as string | null) ?? cursor;
    pages++;
    if (!page.hasNextPage) break;
  }

  pages = 0;
  let claimCursor: string | null = null;
  while (pages < 20) {
    const page = await queryEvents(claimEventType(), claimCursor);
    if (!page.data.length) break;
    for (const ev of page.data) {
      const p = ev.parsedJson as ClaimEvent;
      if (!p?.pool_id || Number(p.kind) !== CLAIM_REFLECTION) continue;
      const rec = pool(idx, p.pool_id);
      rec.totalClaimed = add(rec.totalClaimed, p.amount);
      const h = holder(rec, p.pool_id, p.who);
      h.claimedReflection = add(h.claimedReflection, p.amount);
      h.unpaidReflection = sub(h.unpaidReflection, p.amount);
      h.updatedMs = Date.now();
    }
    claimCursor = (page.nextCursor as string | null) ?? claimCursor;
    pages++;
    if (!page.hasNextPage) break;
  }

  idx.cursor = cursor;
  await save(idx);
  return {
    pools: Object.keys(idx.pools).length,
    cursor: idx.cursor,
  };
}
