/**
 * Instant 24h MC winner: AdminCap drains Pit<SUI>, hops to quote, Bluefin-buys
 * the winner, burns via InstadexMintLock.
 */
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import {
  ADMIN_CAP,
  APP_URL,
  CALL_PKG,
  CONFIG,
  PIT_SUI,
  SUI,
  USDC,
  USDC_SUI_POOL,
  USDY,
  USDY_USDC_POOL,
  XAGM,
  XAGM_USDC_POOL,
  XAUM,
  XAUM_SUI_POOL,
  gql,
  objectFields,
} from "../chain.ts";
import { bluefinHop, cetusHop, normType, poolSnap } from "../clmm.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";

const EVENT_PKG =
  process.env.ARENA_INSTADEX_PACKAGE ??
  "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3";

type Bell = {
  t?: string;
  n?: string;
  pool?: string;
  lock?: string;
  token?: string;
  quote?: string;
  quoteType?: string;
  digest?: string;
  skipped?: string;
  ts?: number;
};

type Standing = Bell & { t: string };

function quoteKind(quote: string): "SUI" | "USDY" | "XAGM" | "XAUM" {
  const s = String(quote || "");
  if (/usdy/i.test(s)) return "USDY";
  if (/xagm/i.test(s)) return "XAGM";
  if (/xaum/i.test(s)) return "XAUM";
  if (s === "USDY" || s === "XAGM" || s === "XAUM") return s;
  return "SUI";
}

function quoteTypeOf(kind: string, quoteType?: string): string {
  if (quoteType && quoteType.includes("::")) return normType(quoteType);
  if (kind === "USDY") return USDY;
  if (kind === "XAGM") return XAGM;
  if (kind === "XAUM") return XAUM;
  return SUI;
}

async function loadPitState(): Promise<{ bells: Bell[]; standing: Standing[] }> {
  const r = await fetch(`${APP_URL}/api/pit-state`, { cache: "no-store" });
  const j = (await r.json()) as { error?: string; bells?: Bell[]; standing?: Standing[] };
  if (!r.ok || j.error) throw new Error(j.error || "pit-state " + r.status);
  return { bells: j.bells || [], standing: j.standing || [] };
}

async function markBell(body: Record<string, unknown>) {
  const secret = process.env.CRON_SECRET || process.env.ARENA_SETTLE_SECRET || "";
  if (!secret) return { skipped: true, reason: "no CRON_SECRET to mark bell" };
  const r = await fetch(`${APP_URL}/api/pit-state`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + secret },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, body: j };
}

async function mintLockId(token: string, lockId: string): Promise<string | null> {
  const t = normType(token);
  const type = `${EVENT_PKG}::launch::InstadexMintLock<${t}>`;
  const q =
    "query($t:String!){ objects(first:5, filter:{ type:$t }){ nodes{ address } } }";
  try {
    const data = (await gql(q, { t: type })) as {
      objects?: { nodes?: { address?: string }[] };
    };
    const addr = data.objects?.nodes?.[0]?.address;
    if (addr) return addr;
  } catch {
    /* fall through */
  }
  const q2 =
    "query($t:String!,$first:Int!){ events(first:$first, filter:{ type:$t }){ nodes { contents { json } } } }";
  for (const pkg of [CALL_PKG, EVENT_PKG, process.env.ARENA_MINTLOCK_PACKAGE].filter(Boolean)) {
    try {
      const data = (await gql(q2, {
        t: `${pkg}::events::InstadexMintLockEvent`,
        first: 50,
      })) as { events?: { nodes?: { contents?: { json?: Record<string, unknown> } }[] } };
      for (const n of data.events?.nodes || []) {
        const p = n.contents?.json || {};
        const lid = String(p.lock_id || "");
        const mid = String(p.mint_lock_id || "");
        if (lid.replace(/^0x/, "") === lockId.replace(/^0x/, "") && mid) {
          return mid.startsWith("0x") ? mid : "0x" + mid;
        }
      }
    } catch {
      /* next pkg */
    }
  }
  return null;
}

async function adminOwnedBy(addr: string): Promise<boolean> {
  const obj = await client().getObject({ id: ADMIN_CAP, options: { showOwner: true } });
  const owner = obj.data?.owner;
  if (!owner || typeof owner !== "object") return false;
  if ("AddressOwner" in owner) {
    return String((owner as { AddressOwner: string }).AddressOwner).toLowerCase() === addr.toLowerCase();
  }
  return false;
}

function pendingBell(bells: Bell[], standing: Standing[]): (Bell & Standing) | null {
  const open = (bells || []).find((b) => b && b.t && !b.digest && !b.skipped);
  if (!open || !open.t) return null;
  const row = (standing || []).find((s) => String(s.t).toUpperCase() === String(open.t).toUpperCase());
  return { ...(row || {}), ...open, t: open.t } as Bell & Standing;
}

export async function runSettleInstadex() {
  const kp = loadSigner();
  const keeper = kp.getPublicKey().toSuiAddress();
  const state = await loadPitState();
  const bell = pendingBell(state.bells, state.standing);
  if (!bell) return { keeper, skipped: true, reason: "no unsettled bell" };

  const pit = await objectFields(PIT_SUI);
  const potRaw = pit && pit.fields.pot;
  const pot = Number(
    potRaw && typeof potRaw === "object"
      ? (potRaw as { fields?: { value?: unknown }; value?: unknown }).fields?.value ??
        (potRaw as { value?: unknown }).value ??
        0
      : potRaw || 0,
  );
  if (!(pot > 0)) {
    const marked = await markBell({ ticker: bell.t, skipped: "empty pot" });
    return { keeper, skipped: true, reason: "empty pot", ticker: bell.t, marked };
  }

  if (!(await adminOwnedBy(keeper))) {
    return {
      keeper,
      skipped: true,
      reason: "keeper does not own AdminCap " + ADMIN_CAP,
      ticker: bell.t,
    };
  }

  const token = normType(bell.token || "");
  const pool = bell.pool || "";
  const lock = bell.lock || "";
  if (!token || !pool || !lock) {
    return { keeper, skipped: true, reason: "bell missing token/pool/lock", bell };
  }
  const mint = await mintLockId(token, lock);
  if (!mint) return { keeper, skipped: true, reason: "InstadexMintLock missing", token, lock };

  const kind = quoteKind(bell.quoteType || bell.quote || "");
  const qType = quoteTypeOf(kind, bell.quoteType);
  const leftoverTo = keeper;
  const tx = new Transaction();
  tx.setSender(keeper);

  const suiCoin = tx.moveCall({
    target: `${CALL_PKG}::config::take_pit_pot_for_burn`,
    typeArguments: [SUI],
    arguments: [tx.object(CONFIG), tx.object(ADMIN_CAP), tx.object(PIT_SUI), tx.pure.id(pool)],
  });

  const insta = await poolSnap(pool);
  let quoteCoin: TransactionObjectArgument = suiCoin;
  if (kind === "SUI") {
    quoteCoin = suiCoin;
  } else if (kind === "USDY") {
    const usdcSui = await poolSnap(USDC_SUI_POOL);
    const usdyUsdc = await poolSnap(USDY_USDC_POOL);
    const usdcCoin = cetusHop(tx, usdcSui, SUI, suiCoin, leftoverTo);
    quoteCoin = cetusHop(tx, usdyUsdc, USDC, usdcCoin, leftoverTo);
  } else if (kind === "XAGM") {
    const usdcSui = await poolSnap(USDC_SUI_POOL);
    const xagmUsdc = await poolSnap(XAGM_USDC_POOL);
    const usdcCoin = cetusHop(tx, usdcSui, SUI, suiCoin, leftoverTo);
    quoteCoin = bluefinHop(tx, xagmUsdc, USDC, usdcCoin, 1n, leftoverTo);
  } else if (kind === "XAUM") {
    const xaumSui = await poolSnap(XAUM_SUI_POOL);
    quoteCoin = bluefinHop(tx, xaumSui, SUI, suiCoin, 1n, leftoverTo);
  }

  const tokCoin = bluefinHop(tx, insta, qType, quoteCoin, 1n, leftoverTo);
  tx.moveCall({
    target: `${CALL_PKG}::launch::burn_pit_buy`,
    typeArguments: [token],
    arguments: [tx.object(mint), tx.pure.id(lock), tokCoin],
  });

  const sent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  const status = sent.effects?.status?.status;
  let burned = 0;
  for (const ev of sent.events || []) {
    const t = String(ev.type || "");
    if (!t.endsWith("::events::InstadexBurnEvent")) continue;
    const p = (ev.parsedJson || {}) as { amount?: string | number };
    burned += Number(p.amount || 0);
  }
  const marked = await markBell({
    ticker: bell.t,
    digest: sent.digest,
    burned,
    amount: pot,
  });
  return {
    keeper,
    ticker: bell.t,
    pool,
    mint,
    quote: kind,
    digest: sent.digest,
    status,
    pot,
    burned,
    marked,
    callPackage: CALL_PKG,
  };
}
