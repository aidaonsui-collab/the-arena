/**
 * Persist the RH deposit-watcher cursor and its retry queue.
 *
 * The old watcher kept `fromBlock` and a `seen` Set in memory only, and
 * advanced `fromBlock = tip + 1` at the end of every pass regardless of what
 * happened. Two consequences:
 *
 *   - a mint that threw (RPC blip, gas, transient signer failure) was never
 *     retried — the depositor's collateral stayed locked with no wrapper, and
 *     nothing recorded that it had been dropped;
 *   - a restart reset the cursor to `tip - RH_WATCH_LOOKBACK`, so any outage
 *     longer than the lookback silently skipped every deposit in between.
 *
 * Both are fixed by keeping the cursor on disk and parking failures in an
 * explicit queue instead of letting the cursor step over them.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env } from "./config.ts";
import type { DepositLockedLog } from "./rhWatcher.ts";

/** Give up automatic retries after this many failed passes, and shout. */
export const MAX_MINT_ATTEMPTS = 10;

export type PendingMint = {
  event: DepositLockedLog;
  attempts: number;
  lastError: string;
  firstSeenAt: string;
  lastTriedAt: string;
  /** Exhausted automatic retries; needs an operator. Never silently dropped. */
  deadLettered?: boolean;
};

type Store = {
  /** Next block to scan from. Only advances past fully-handled ranges. */
  nextFromBlock: number | null;
  /** Deposits seen but not yet minted, keyed by `${txHash}:${depositId}`. */
  pending: Record<string, PendingMint>;
};

function storePath() {
  return join(env().dataDir, "rh-watch.json");
}

function empty(): Store {
  return { nextFromBlock: null, pending: {} };
}

export function loadWatchStore(): Store {
  const p = storePath();
  if (!existsSync(p)) return empty();
  try {
    const raw = JSON.parse(readFileSync(p, "utf8")) as Partial<Store>;
    return {
      nextFromBlock: typeof raw.nextFromBlock === "number" ? raw.nextFromBlock : null,
      pending: raw.pending ?? {},
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

export function savedFromBlock(): number | null {
  return loadWatchStore().nextFromBlock;
}

export function saveFromBlock(block: number) {
  const store = loadWatchStore();
  store.nextFromBlock = block;
  save(store);
}

export function pendingMints(): PendingMint[] {
  return Object.values(loadWatchStore().pending);
}

/** Pending entries still eligible for an automatic retry. */
export function retryableMints(): PendingMint[] {
  return pendingMints().filter((p) => !p.deadLettered);
}

/** Exhausted retries — surfaced every pass so they cannot rot unnoticed. */
export function deadLetteredMints(): PendingMint[] {
  return pendingMints().filter((p) => p.deadLettered);
}

export function recordMintFailure(key: string, event: DepositLockedLog, error: string) {
  const store = loadWatchStore();
  const now = new Date().toISOString();
  const prev = store.pending[key];
  const attempts = (prev?.attempts ?? 0) + 1;
  store.pending[key] = {
    event,
    attempts,
    lastError: error,
    firstSeenAt: prev?.firstSeenAt ?? now,
    lastTriedAt: now,
    deadLettered: attempts >= MAX_MINT_ATTEMPTS,
  };
  save(store);
}

/** Drop a deposit from the queue — minted, or terminally not mintable. */
export function clearPendingMint(key: string) {
  const store = loadWatchStore();
  if (store.pending[key]) {
    delete store.pending[key];
    save(store);
  }
}
