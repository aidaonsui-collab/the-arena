/**
 * Permissionless collect_instadex_fees for every Instadex lock with accrued LP fees.
 * Burns coin A, splits quote 60/10/30. Signs with ARENA_KEEPER_PHRASE if set, else the local Sui keystore (gas only).
 */
import { loadSigner } from "../loadSigner.ts";
import { Transaction } from "@mysten/sui/transactions";
import { client } from "../sui.ts";

const GQL = process.env.SUI_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql";
const CLOCK = "0x6";
const BF_CONFIG = "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352";
const CONFIG = "0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c";
const PIT_SUI = "0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c";
const PIT_XAUM = "0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783";
const CALL_PKG =
  process.env.ARENA_CALL_PACKAGE ??
  "0x488ef44083be97cdcb518ab8fd9c9e60e189b7fd3e5d82f749b43c0af5dc078a";
const EVENT_PKG =
  process.env.ARENA_INSTADEX_PACKAGE ??
  "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3";

type Launch = {
  lockId: string;
  poolId: string;
  token: string;
  quote: string;
  digest: string;
  mintLockId?: string;
};

function typeNameOf(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as { name?: string; address?: string; module?: string };
    if (o.address && o.module) return `${o.address}::${o.module}::${o.name ?? ""}`;
    if (o.name) return String(o.name);
  }
  return String(v);
}

function asId(v: unknown): string {
  if (typeof v === "string") return v.startsWith("0x") ? v : `0x${v}`;
  if (v && typeof v === "object" && "id" in (v as object)) return asId((v as { id: unknown }).id);
  return String(v ?? "");
}

function pitFor(quote: string): string | null {
  const s = quote || "";
  if (/usdy/i.test(s)) return process.env.ARENA_PIT_USDY || "";
  if (/xagm/i.test(s)) return process.env.ARENA_PIT_XAGM || "";
  if (/xaum/i.test(s)) return process.env.ARENA_PIT_XAUM || PIT_XAUM;
  return process.env.ARENA_PIT_SUI || PIT_SUI;
}

async function gql(query: string, variables: Record<string, unknown>) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await r.json()) as { data?: unknown; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}

async function listLaunches(): Promise<Launch[]> {
  const type = `${EVENT_PKG}::events::InstadexLaunchEvent`;
  const q = `query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } transaction { digest } } } }`;
  const out: Launch[] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const data = (await gql(q, { t: type, first: 50, after })) as {
      events?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        nodes?: { contents?: { json?: Record<string, unknown> }; transaction?: { digest?: string } }[];
      };
    };
    const nodes = data.events?.nodes ?? [];
    for (const n of nodes) {
      const p = n.contents?.json ?? {};
      out.push({
        lockId: asId(p.lock_id),
        poolId: asId(p.bluefin_pool_id),
        token: typeNameOf(p.token),
        quote: typeNameOf(p.quote),
        digest: String(n.transaction?.digest ?? ""),
      });
    }
    if (!data.events?.pageInfo?.hasNextPage || !data.events.pageInfo.endCursor) break;
    after = data.events.pageInfo.endCursor;
  }
  return out;
}

async function listMintLocks(): Promise<Map<string, string>> {
  const types = [
    `${CALL_PKG}::events::InstadexMintLockEvent`,
    process.env.ARENA_MINTLOCK_PACKAGE
      ? `${process.env.ARENA_MINTLOCK_PACKAGE}::events::InstadexMintLockEvent`
      : "",
  ].filter(Boolean);
  const map = new Map<string, string>();
  const q = `query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }`;
  for (const type of types) {
    let after: string | null = null;
    for (let i = 0; i < 20; i++) {
      let data: {
        events?: {
          pageInfo?: { hasNextPage?: boolean; endCursor?: string };
          nodes?: { contents?: { json?: Record<string, unknown> } }[];
        };
      };
      try {
        data = (await gql(q, { t: type, first: 50, after })) as typeof data;
      } catch {
        break;
      }
      for (const n of data.events?.nodes ?? []) {
        const p = n.contents?.json ?? {};
        const lockId = asId(p.lock_id);
        const mintId = asId(p.mint_lock_id);
        if (lockId && mintId) map.set(lockId, mintId);
      }
      if (!data.events?.pageInfo?.hasNextPage || !data.events.pageInfo.endCursor) break;
      after = data.events.pageInfo.endCursor;
    }
  }
  return map;
}

async function mintLockFromTx(digest: string, token: string): Promise<string | null> {
  const c = client();
  const tx = await c.getTransactionBlock({ digest, options: { showObjectChanges: true } });
  const needle = `::launch::InstadexMintLock<${token}>`;
  const needleAlt = `::launch::InstadexMintLock<${token.replace(/^0x0+/, "0x")}>`;
  for (const ch of tx.objectChanges ?? []) {
    if (ch.type !== "created" || !("objectType" in ch)) continue;
    const ot = String(ch.objectType);
    if (ot.includes("InstadexMintLock") && (ot.includes(token) || ot.includes(needle) || ot.includes(needleAlt))) {
      return ch.objectId;
    }
  }
  const fallback = (tx.objectChanges ?? []).find(
    (ch) => ch.type === "created" && "objectType" in ch && String(ch.objectType).includes("InstadexMintLock"),
  );
  return fallback && fallback.type === "created" ? fallback.objectId : null;
}

const Q64 = 1n << 64n;

function asBig(v: unknown): bigint {
  if (v == null) return 0n;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return Number.isFinite(v) ? BigInt(Math.trunc(v)) : 0n;
  if (typeof v === "string") {
    const s = v.trim();
    if (!s || !/^\d+$/.test(s)) return 0n;
    return BigInt(s);
  }
  if (typeof v === "object") {
    const o = v as Record<string, unknown>;
    if (o.value != null) return asBig(o.value);
    if (o.fields != null) return asBig(o.fields);
  }
  return 0n;
}

function fieldsOf(node: unknown): Record<string, unknown> | null {
  if (!node || typeof node !== "object") return null;
  const o = node as Record<string, unknown>;
  if (o.fields && typeof o.fields === "object") return o.fields as Record<string, unknown>;
  return o;
}

function positionFields(lockFields: Record<string, unknown>): Record<string, unknown> | null {
  return fieldsOf(lockFields.position);
}

/** Owed tokens plus CLMM pending from fee growth. token_*_fee stays 0 until collect. */
function pendingFromPosition(
  pos: Record<string, unknown>,
  pool: Record<string, unknown> | null,
): { a: number; b: number; liquidity: string } {
  const L = asBig(pos.liquidity);
  const owedA = asBig(pos.token_a_fee);
  const owedB = asBig(pos.token_b_fee);
  let pendA = 0n;
  let pendB = 0n;
  if (pool && L > 0n) {
    const dA = asBig(pool.fee_growth_global_coin_a) - asBig(pos.fee_growth_coin_a);
    const dB = asBig(pool.fee_growth_global_coin_b) - asBig(pos.fee_growth_coin_b);
    if (dA > 0n) pendA = (L * dA) / Q64;
    if (dB > 0n) pendB = (L * dB) / Q64;
  }
  return { a: Number(owedA + pendA), b: Number(owedB + pendB), liquidity: L.toString() };
}

async function accrued(
  lockId: string,
): Promise<{ a: number; b: number; liquidity: string; poolId: string }> {
  const obj = await client().getObject({ id: lockId, options: { showContent: true } });
  const content = obj.data?.content;
  if (!content || content.dataType !== "moveObject") {
    return { a: 0, b: 0, liquidity: "0", poolId: "" };
  }
  const lock = (content.fields || {}) as Record<string, unknown>;
  const pos = positionFields(lock);
  const poolId = String(lock.bluefin_pool_id || (pos && pos.pool_id) || "");
  if (!pos) return { a: 0, b: 0, liquidity: "0", poolId };
  let poolFields: Record<string, unknown> | null = null;
  if (poolId) {
    try {
      const pool = await client().getObject({ id: poolId, options: { showContent: true } });
      const pc = pool.data?.content;
      if (pc && pc.dataType === "moveObject") poolFields = (pc.fields || {}) as Record<string, unknown>;
    } catch {
      poolFields = null;
    }
  }
  const pending = pendingFromPosition(pos, poolFields);
  return { ...pending, poolId };
}

export async function runCollectInstadex() {
  const kp = loadSigner();
  const launches = await listLaunches();
  const mintByLock = await listMintLocks();
  const results: unknown[] = [];
  for (const L of launches) {
    if (!L.lockId || !L.poolId || !L.token || !L.digest) continue;
    const mintId =
      L.mintLockId ?? mintByLock.get(L.lockId) ?? (await mintLockFromTx(L.digest, L.token));
    if (!mintId) {
      results.push({ lockId: L.lockId, skipped: true, reason: "no InstadexMintLock in launch tx" });
      continue;
    }
    const fees = await accrued(L.lockId);
    // Instant CLMM fees sit in fee_growth until collect. token_*_fee is usually 0.
    // Skip only if the NFT is empty and growth says nothing is pending.
    if (BigInt(fees.liquidity || "0") <= 0n && fees.a <= 0 && fees.b <= 0) {
      results.push({ lockId: L.lockId, skipped: true, reason: "no accrued fees", fees });
      continue;
    }
    const pit = pitFor(L.quote);
    if (!pit) {
      results.push({ lockId: L.lockId, skipped: true, reason: "no Pit<" + (L.quote || "Q") + "> registered" });
      continue;
    }
    const tx = new Transaction();
    tx.moveCall({
      target: `${CALL_PKG}::launch::collect_instadex_fees`,
      typeArguments: [L.token, L.quote || "0x2::sui::SUI"],
      arguments: [
        tx.object(L.lockId),
        tx.object(mintId),
        tx.object(CLOCK),
        tx.object(BF_CONFIG),
        tx.object(L.poolId),
        tx.object(process.env.ARENA_CONFIG || CONFIG),
        tx.object(pit),
      ],
    });
    try {
      const sent = await client().signAndExecuteTransaction({
        signer: kp,
        transaction: tx,
        options: { showEffects: true },
      });
      results.push({
        lockId: L.lockId,
        digest: sent.digest,
        status: sent.effects?.status?.status,
        fees,
      });
    } catch (e) {
      results.push({ lockId: L.lockId, error: e instanceof Error ? e.message : String(e), fees });
    }
  }
  return {
    keeper: kp.getPublicKey().toSuiAddress(),
    callPackage: CALL_PKG,
    n: launches.length,
    results,
  };
}

