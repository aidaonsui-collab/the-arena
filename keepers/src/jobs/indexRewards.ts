/**
 * Basket-yield push index. Runs on Jessica's Air.
 * Continues the cursor saved in rewards-index/vicefun.json and POSTs the
 * wallet map back. Vercel only stores the blob; it does not walk Sui.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { APP_URL, GQL } from "../chain.ts";

const EVENT_PKGS = [
  "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3",
  "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9",
  "0x1c808e5fe7f14703a72cae3cd71ebba98b3a9a97dc530feed6222595bfb4a853",
  "0x3ccc57531949d6f24178bd57fe20496ee4ff515e26c280f1b80f658bc020bcbe",
];
const VICEFUN_REWARDS_VAULT = "0x3b8a61405825146ee68f351363f29a3e4206683fced840ea10cdfba50fe075e7";
const MAX_MS = 45_000;
const LOCAL = join(dirname(fileURLToPath(import.meta.url)), "../../data/rewards-index.json");

type State = {
  wallets: Record<string, Record<string, string>>;
  cursors: Record<string, string>;
  updatedMs: number;
};

function normAddr(a: unknown): string {
  let s = String(a || "").trim().toLowerCase();
  if (!s) return "";
  if (!s.startsWith("0x")) s = "0x" + s;
  const hex = s.slice(2).replace(/^0+/, "") || "0";
  return "0x" + hex.padStart(64, "0");
}

function empty(): State {
  return { wallets: {}, cursors: {}, updatedMs: 0 };
}

function loadLocal(): State | null {
  try {
    const j = JSON.parse(readFileSync(LOCAL, "utf8")) as State;
    if (!j || typeof j !== "object") return null;
    if (!j.wallets) j.wallets = {};
    if (!j.cursors) j.cursors = {};
    return j;
  } catch {
    return null;
  }
}

async function loadRemote(secret: string): Promise<State> {
  const r = await fetch(`${APP_URL}/api/rewards-index?dump=1`, {
    headers: { authorization: `Bearer ${secret}` },
    cache: "no-store",
  });
  if (!r.ok) return empty();
  const j = (await r.json()) as State;
  if (!j || typeof j !== "object") return empty();
  if (!j.wallets) j.wallets = {};
  if (!j.cursors) j.cursors = {};
  return j;
}

async function fetchPage(type: string, after: string | null) {
  const query = after
    ? "query($type:String!,$first:Int!,$after:String!){ events(filter:{ type:$type }, first:$first, after:$after){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }"
    : "query($type:String!,$first:Int!){ events(filter:{ type:$type }, first:$first){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }";
  const variables: Record<string, unknown> = { type, first: 50 };
  if (after) variables.after = after;
  let last = "";
  for (let attempt = 0; attempt < 6; attempt++) {
    const r = await fetch(GQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables }),
    });
    const j = (await r.json()) as {
      data?: { events?: { pageInfo?: { hasNextPage?: boolean; endCursor?: string }; nodes?: { contents?: { json?: Record<string, unknown> } }[] } };
      errors?: { message?: string }[];
    };
    if (j.errors?.length) {
      last = j.errors[0].message || "graphql";
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      continue;
    }
    if (!j.data?.events) {
      last = "empty events";
      await new Promise((res) => setTimeout(res, 400 * (attempt + 1)));
      continue;
    }
    return j.data.events;
  }
  throw new Error(last || "events query failed");
}

export async function runIndexRewards() {
  const secret = process.env.ARENA_SETTLE_SECRET || process.env.CRON_SECRET || "";
  if (!secret) return { skipped: "no CRON_SECRET" };
  const state = loadLocal() || (await loadRemote(secret));
  const t0 = Date.now();
  let pagesDone = 0;
  let eventsMatched = 0;
  const stalled: { pkg: string; error: string }[] = [];

  for (const pkg of EVENT_PKGS) {
    const type = pkg + "::events::BasketYieldPushEvent";
    let cursor: string | null = state.cursors[pkg] || null;
    for (;;) {
      if (Date.now() - t0 > MAX_MS) break;
      let page;
      try {
        page = await fetchPage(type, cursor);
      } catch (e) {
        stalled.push({ pkg, error: e instanceof Error ? e.message : String(e) });
        break;
      }
      pagesDone++;
      for (const n of page.nodes || []) {
        const j = (n.contents && n.contents.json) || {};
        if (normAddr(j.basket_id) !== VICEFUN_REWARDS_VAULT) continue;
        const addr = normAddr(j.recipient);
        const asset = typeof j.asset === "string" ? j.asset : "";
        if (!addr || !asset) continue;
        let amount = 0n;
        try {
          amount = BigInt(String(j.amount || "0"));
        } catch {
          continue;
        }
        const w = state.wallets[addr] || (state.wallets[addr] = {});
        const prev = w[asset] ? BigInt(w[asset]) : 0n;
        w[asset] = String(prev + amount);
        eventsMatched++;
      }
      if (page.pageInfo?.endCursor) {
        cursor = page.pageInfo.endCursor;
        state.cursors[pkg] = cursor;
      }
      if (!page.pageInfo?.hasNextPage) break;
      if (Date.now() - t0 > MAX_MS) break;
    }
    if (Date.now() - t0 > MAX_MS) break;
  }

  state.updatedMs = Date.now();
  mkdirSync(dirname(LOCAL), { recursive: true });
  writeFileSync(LOCAL, JSON.stringify(state));
  const r = await fetch(`${APP_URL}/api/rewards-index`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${secret}` },
    body: JSON.stringify({ wallets: state.wallets, cursors: state.cursors }),
  });
  const raw = await r.text();
  if (!r.ok) throw new Error(raw.slice(0, 180) || `rewards ${r.status}`);
  return {
    ok: true,
    pagesDone,
    eventsMatched,
    wallets: Object.keys(state.wallets).length,
    stalled,
    tookMs: Date.now() - t0,
  };
}
