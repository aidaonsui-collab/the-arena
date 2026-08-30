/**
 * Permissionless collect_instadex_fees for every Instadex lock with accrued LP fees.
 * Burns coin A, splits quote 60/10/30. Needs ARENA_KEEPER_PHRASE (gas only, not AdminCap).
 */
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { Transaction } from "@mysten/sui/transactions";
import { client } from "../sui.ts";

const GQL = process.env.SUI_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql";
const CLOCK = "0x6";
const BF_CONFIG = "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352";
const CONFIG = "0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c";
const PIT_SUI = "0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c";
const PIT_XAUM = "0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783";
const XAUM = "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";
const CALL_PKG =
  process.env.ARENA_CALL_PACKAGE ??
  "0x47ea732e44f21470aa3dd449a7b26731ed2c377e2c02e650f3ede6ea581bf000";
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

function isXaum(quote: string): boolean {
  return /xaum/i.test(quote);
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

function walkFees(node: unknown): { a: number; b: number } {
  let a = 0;
  let b = 0;
  const visit = (x: unknown) => {
    if (!x || typeof x !== "object") return;
    const o = x as Record<string, unknown>;
    if (o.token_a_fee != null) a = Number(o.token_a_fee) || a;
    if (o.token_b_fee != null) b = Number(o.token_b_fee) || b;
    for (const v of Object.values(o)) visit(v);
  };
  visit(node);
  return { a, b };
}

async function accrued(lockId: string): Promise<{ a: number; b: number }> {
  const obj = await client().getObject({ id: lockId, options: { showContent: true } });
  const content = obj.data?.content;
  if (!content || content.dataType !== "moveObject") return { a: 0, b: 0 };
  return walkFees(content.fields);
}

function keypair() {
  const phrase = process.env.ARENA_KEEPER_PHRASE ?? "";
  if (!phrase) return null;
  return Ed25519Keypair.deriveKeypair(phrase.trim());
}

export async function runCollectInstadex() {
  const phraseMissing = !process.env.ARENA_KEEPER_PHRASE;
  if (phraseMissing) {
    return { skipped: true, reason: "ARENA_KEEPER_PHRASE unset" };
  }
  const kp = keypair();
  if (!kp) return { skipped: true, reason: "ARENA_KEEPER_PHRASE unset" };
  const launches = await listLaunches();
  const results: unknown[] = [];
  for (const L of launches) {
    if (!L.lockId || !L.poolId || !L.token || !L.digest) continue;
    const mintId = L.mintLockId ?? (await mintLockFromTx(L.digest, L.token));
    if (!mintId) {
      results.push({ lockId: L.lockId, skipped: true, reason: "no InstadexMintLock in launch tx" });
      continue;
    }
    const fees = await accrued(L.lockId);
    if (fees.a <= 0 && fees.b <= 0) {
      results.push({ lockId: L.lockId, skipped: true, reason: "no accrued fees", fees });
      continue;
    }
    const pit = isXaum(L.quote) ? (process.env.ARENA_PIT_XAUM || PIT_XAUM) : (process.env.ARENA_PIT_SUI || PIT_SUI);
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

