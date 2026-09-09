/**
 * Persist matched RedeemBurned events and released depositIds so a restart
 * does not re-release. Mirrors dedupe.ts (local JSON under STOCKS_DATA_DIR).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "./config.ts";
import type { EventCursor } from "./sui.ts";

export type ReleaseAttempt = {
  depositId: string;
  to: string;
  token: string;
  rhAmount: string;
  suiAmount: string;
  simulatedOk?: boolean;
  simulateError?: string;
  txHash?: string;
  error?: string;
};

export type BurnRecord = {
  key: string;
  digest: string;
  eventSeq: string;
  ticker: string;
  amount: string;
  burner: string;
  rhDest: string;
  status: "exact" | "partial" | "unmatched" | "error";
  leftoverSui: string;
  mismatch: string | null;
  consumedDepositIds: string[];
  releasedDepositIds: string[];
  releases: ReleaseAttempt[];
  dryRun: boolean;
  at: string;
};

export type ReleasedDeposit = {
  depositId: string;
  burnKey: string;
  txHash?: string;
  at: string;
  dryRun?: boolean;
};

type Store = {
  cursor: EventCursor | null;
  burns: Record<string, BurnRecord>;
  releasedDepositIds: Record<string, ReleasedDeposit>;
};

function storePath() {
  return join(env().dataDir, "redeemed.json");
}

function empty(): Store {
  return { cursor: null, burns: {}, releasedDepositIds: {} };
}

export function loadRedeemStore(): Store {
  const p = storePath();
  if (!existsSync(p)) return empty();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Store>;
    return {
      cursor: raw.cursor ?? null,
      burns: raw.burns ?? {},
      releasedDepositIds: raw.releasedDepositIds ?? {},
    };
  } catch {
    return empty();
  }
}

function save(store: Store) {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
}

export function lookupBurn(key: string): BurnRecord | null {
  return loadRedeemStore().burns[key] ?? null;
}

export function isDepositReleased(depositId: string): boolean {
  const rec = loadRedeemStore().releasedDepositIds[depositId];
  return !!(rec && !rec.dryRun);
}

/** True if any persisted burn already consumed this lock (dry-run or live). */
export function isDepositClaimed(depositId: string, exceptBurnKey?: string): boolean {
  if (isDepositReleased(depositId)) return true;
  const store = loadRedeemStore();
  for (const rec of Object.values(store.burns)) {
    if (exceptBurnKey && rec.key === exceptBurnKey) continue;
    if (rec.consumedDepositIds.includes(depositId)) return true;
  }
  return false;
}

export function pendingDepositIds(rec: BurnRecord): string[] {
  return rec.consumedDepositIds.filter((id) => !rec.releasedDepositIds.includes(id));
}

export function alreadyHandled(key: string, live: boolean): boolean {
  const rec = lookupBurn(key);
  if (!rec) return false;
  if (rec.dryRun && live) return false;
  if (!rec.dryRun && live && pendingDepositIds(rec).length > 0) return false;
  return true;
}

export function recordBurn(rec: BurnRecord) {
  const store = loadRedeemStore();
  store.burns[rec.key] = rec;
  for (const id of rec.releasedDepositIds) {
    const attempt = rec.releases.find((r) => r.depositId === id);
    store.releasedDepositIds[id] = {
      depositId: id,
      burnKey: rec.key,
      txHash: attempt?.txHash,
      at: rec.at,
      dryRun: rec.dryRun,
    };
  }
  save(store);
}

export function saveCursor(cursor: EventCursor | null) {
  const store = loadRedeemStore();
  store.cursor = cursor;
  save(store);
}

export function currentCursor(): EventCursor | null {
  return loadRedeemStore().cursor;
}
