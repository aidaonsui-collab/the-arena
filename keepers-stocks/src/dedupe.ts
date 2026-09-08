/**
 * Dedupe mint attestations by rh_ref so the same RH tx cannot mint twice.
 * Local JSON log + optional on-chain MintedEvent scan.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { env, mintedEventType } from "./config.ts";
import { client } from "./sui.ts";

export type MintRecord = {
  rhRef: string;
  rhRefHex: string;
  ticker: string;
  amount: string;
  recipient: string;
  digest?: string;
  at: string;
  dryRun?: boolean;
};

type Store = { byRhRef: Record<string, MintRecord> };

function storePath() {
  return join(env().dataDir, "minted-refs.json");
}

function load(): Store {
  const p = storePath();
  if (!existsSync(p)) return { byRhRef: {} };
  try {
    return JSON.parse(readFileSync(p, "utf8")) as Store;
  } catch {
    return { byRhRef: {} };
  }
}

function save(store: Store) {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(store, null, 2) + "\n");
}

export function normalizeRhRefKey(rhRefRaw: string): { key: string; bytes: number[]; display: string } {
  const raw = rhRefRaw.trim();
  if (!raw) throw new Error("rh-ref is required");
  let bytes: number[];
  let display: string;
  if (/^0x[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0) {
    const hex = raw.slice(2);
    bytes = [];
    for (let i = 0; i < hex.length; i += 2) bytes.push(parseInt(hex.slice(i, i + 2), 16));
    display = raw.toLowerCase();
  } else if (/^[0-9a-fA-F]+$/.test(raw) && raw.length % 2 === 0 && raw.length >= 8) {
    bytes = [];
    for (let i = 0; i < raw.length; i += 2) bytes.push(parseInt(raw.slice(i, i + 2), 16));
    display = `0x${raw.toLowerCase()}`;
  } else {
    bytes = Array.from(Buffer.from(raw, "utf8"));
    display = raw;
  }
  const key = Buffer.from(bytes).toString("hex");
  return { key, bytes, display };
}

export function localLookup(rhRefKey: string): MintRecord | null {
  const store = load();
  return store.byRhRef[rhRefKey] ?? null;
}

export function recordMint(rec: MintRecord) {
  const store = load();
  const existing = store.byRhRef[rec.rhRef];
  if (existing && !existing.dryRun && !rec.dryRun) {
    throw new Error(`rh_ref already minted locally: ${existing.digest ?? existing.at}`);
  }
  store.byRhRef[rec.rhRef] = rec;
  save(store);
}

/** Best-effort: scan recent MintedEvent for matching rh_ref bytes (hex). */
export async function onChainLookup(rhRefKey: string): Promise<{ digest: string; amount?: string } | null> {
  const c = client();
  const type = mintedEventType();
  let cursor: { txDigest: string; eventSeq: string } | null = null;
  for (let page = 0; page < 10; page++) {
    const res = await c.queryEvents({
      query: { MoveEventType: type },
      cursor: cursor as never,
      limit: 50,
      order: "descending",
    });
    for (const ev of res.data) {
      const pj = (ev.parsedJson || {}) as { rh_ref?: number[] | string; amount?: unknown };
      let hex = "";
      if (Array.isArray(pj.rh_ref)) {
        hex = Buffer.from(pj.rh_ref.map((n) => Number(n) & 0xff)).toString("hex");
      } else if (typeof pj.rh_ref === "string") {
        const s = pj.rh_ref.startsWith("0x") ? pj.rh_ref.slice(2) : pj.rh_ref;
        hex = /^[0-9a-fA-F]+$/.test(s) ? s.toLowerCase() : Buffer.from(s, "utf8").toString("hex");
      }
      if (hex === rhRefKey) {
        return {
          digest: ev.id.txDigest,
          amount: String(pj.amount ?? ""),
        };
      }
    }
    if (!res.hasNextPage || !res.nextCursor) break;
    cursor = res.nextCursor as { txDigest: string; eventSeq: string };
  }
  return null;
}
