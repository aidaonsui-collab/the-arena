/**
 * Resolve a Transaction's object inputs and gas over Sui GraphQL, so jobs can
 * build PTBs without JSON-RPC. `@mysten/sui` 1.x's GraphQL client cannot resolve
 * transactions itself ("does not support transaction resolution yet").
 *
 * - Owned / immutable objects → ImmOrOwnedObject(version, digest)
 * - Shared objects → SharedObject(initialSharedVersion, mutable), where mutable
 *   comes from the Move signature (&mut or by-value) of every call that uses it.
 * - Gas: explicit payment (live) or empty payment (checks-off simulation).
 */
import type { Transaction } from "@mysten/sui/transactions";
import { gql } from "./chain.ts";

type ObjInfo = { version: string; digest: string; shared?: string };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function normId(id: string): string {
  return "0x" + String(id).toLowerCase().replace(/^0x/, "").padStart(64, "0");
}

/**
 * Minimum object versions we know exist on chain (from our own executed tx
 * effects). GraphQL can lag a checkpoint behind; reads below these versions are
 * stale and would make the next tx reference an already-consumed object.
 */
const minVersions = new Map<string, bigint>();
export function noteMinVersion(id: string, version: bigint | number | string) {
  const k = normId(id);
  const v = BigInt(version);
  if ((minVersions.get(k) ?? 0n) < v) minVersions.set(k, v);
}

/** Poll until GraphQL has indexed `digest` (throws after timeoutMs). */
export async function waitForDigest(digest: string, timeoutMs = 60_000): Promise<void> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const d = (await gql(`query($d:String!){ transaction(digest:$d){ digest effects{ checkpoint{ sequenceNumber } } } }`, {
      d: digest,
    })) as { transaction?: { effects?: { checkpoint?: { sequenceNumber?: number } } } | null };
    if (d.transaction?.effects?.checkpoint?.sequenceNumber != null) return;
    if (Date.now() > until) throw new Error("GraphQL did not index " + digest + " within " + timeoutMs + "ms");
    await sleep(1500);
  }
}

async function objectInfo(id: string, timeoutMs = 60_000): Promise<ObjInfo> {
  const want = minVersions.get(normId(id)) ?? 0n;
  const until = Date.now() + timeoutMs;
  for (;;) {
    const info = await objectInfoOnce(id);
    if (info.shared || BigInt(info.version) >= want) return info;
    if (Date.now() > until) throw new Error(`stale ${id}: GraphQL has v${info.version}, need >= v${want}`);
    await sleep(1500);
  }
}

async function objectInfoOnce(id: string): Promise<ObjInfo> {
  const d = (await gql(
    `query($id:SuiAddress!){ object(address:$id){ version digest owner{ __typename ... on Shared{ initialSharedVersion } } } }`,
    { id },
  )) as { object?: { version: number; digest: string; owner?: { __typename: string; initialSharedVersion?: number } } };
  const o = d.object;
  if (!o) throw new Error("object not found: " + id);
  const shared = o.owner?.__typename === "Shared" ? String(o.owner.initialSharedVersion) : undefined;
  return { version: String(o.version), digest: o.digest, shared };
}

const fnCache = new Map<string, boolean[]>();
/** Per-parameter "needs mutable access" flags (&mut or by value). */
async function paramMutability(pkg: string, mod: string, fn: string): Promise<boolean[]> {
  const key = `${pkg}::${mod}::${fn}`;
  const hit = fnCache.get(key);
  if (hit) return hit;
  const d = (await gql(
    `query($p:SuiAddress!,$m:String!,$f:String!){ package(address:$p){ module(name:$m){ function(name:$f){ parameters{ signature } } } } }`,
    { p: pkg, m: mod, f: fn },
  )) as { package?: { module?: { function?: { parameters?: { signature: { ref?: string } }[] } } } };
  const params = d.package?.module?.function?.parameters;
  if (!params) throw new Error("move function not found: " + key);
  const flags = params.map((p) => p.signature.ref !== "&");
  fnCache.set(key, flags);
  return flags;
}

type Arg = { $kind?: string; Input?: number; kind?: string; index?: number };
function inputIndex(a: unknown): number | null {
  const x = a as Arg;
  if (x && typeof x === "object") {
    if (typeof x.Input === "number") return x.Input;
    if (x.$kind === "Input" && typeof x.index === "number") return x.index;
  }
  return null;
}

export type GasOpts = { price: bigint; budget: bigint; payment: { objectId: string; version: string; digest: string }[] };

/** Install a build plugin that resolves everything via GraphQL. */
export function resolveWithGraphQL(tx: Transaction, gas: GasOpts) {
  tx.addBuildPlugin(async (data, _opts, next) => {
    // Which inputs are used mutably?
    const mutableUse = new Map<number, boolean>();
    const mark = (i: number, m: boolean) => mutableUse.set(i, (mutableUse.get(i) || false) || m);
    for (const cmd of data.commands as any[]) {
      if (cmd.MoveCall) {
        const mc = cmd.MoveCall;
        const flags = await paramMutability(mc.package, mc.module, mc.function);
        (mc.arguments || []).forEach((a: unknown, j: number) => {
          const i = inputIndex(a);
          if (i != null) mark(i, flags[j] ?? true);
        });
      } else {
        const body = Object.values(cmd).find((v) => v && typeof v === "object") as Record<string, unknown> | undefined;
        const walk = (v: unknown) => {
          if (Array.isArray(v)) return v.forEach(walk);
          const i = inputIndex(v);
          if (i != null) mark(i, true);
          else if (v && typeof v === "object") Object.values(v as object).forEach(walk);
        };
        if (body) walk(body);
      }
    }
    for (let i = 0; i < data.inputs.length; i++) {
      const inp = data.inputs[i] as any;
      if (inp.UnresolvedPure) throw new Error(`untyped pure input #${i}; use tx.pure.<type>()`);
      if (!inp.UnresolvedObject) continue;
      const id = inp.UnresolvedObject.objectId;
      const info = await objectInfo(id);
      if (info.shared) {
        data.inputs[i] = {
          $kind: "Object",
          Object: {
            $kind: "SharedObject",
            SharedObject: { objectId: id, initialSharedVersion: info.shared, mutable: mutableUse.get(i) ?? true },
          },
        } as any;
      } else {
        data.inputs[i] = {
          $kind: "Object",
          Object: { $kind: "ImmOrOwnedObject", ImmOrOwnedObject: { objectId: id, version: info.version, digest: info.digest } },
        } as any;
      }
    }
    data.gasConfig.price = String(gas.price);
    data.gasConfig.budget = String(gas.budget);
    data.gasConfig.payment = gas.payment;
    await next();
  });
}

export async function referenceGasPrice(): Promise<bigint> {
  const d = (await gql(`{ epoch{ referenceGasPrice } }`, {})) as { epoch: { referenceGasPrice: string } };
  return BigInt(d.epoch.referenceGasPrice);
}

/** Pick SUI coins owned by `owner` covering `need` mist (largest first). */
export async function pickGasCoins(owner: string, need: bigint, timeoutMs = 60_000) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const d = (await gql(
      `query($a:SuiAddress!){ address(address:$a){ objects(first:50, filter:{ type:"0x2::coin::Coin<0x2::sui::SUI>" }){
        nodes{ address version digest contents{ json } } } } }`,
      { a: owner },
    )) as { address?: { objects?: { nodes: { address: string; version: number; digest: string; contents: { json: { balance: string } } }[] } } };
    const nodes = d.address?.objects?.nodes || [];
    // A coin we mutated but GraphQL still shows at an older version → index lag; wait.
    const stale = nodes.some((n) => BigInt(n.version) < (minVersions.get(normId(n.address)) ?? 0n));
    if (stale) {
      if (Date.now() > until) throw new Error("gas coins still stale in GraphQL after " + timeoutMs + "ms");
      await sleep(1500);
      continue;
    }
    const coins = nodes
      .map((n) => ({ objectId: n.address, version: String(n.version), digest: n.digest, balance: BigInt(n.contents.json.balance) }))
      .sort((a, b) => (b.balance > a.balance ? 1 : -1));
    const out: { objectId: string; version: string; digest: string }[] = [];
    let sum = 0n;
    for (const c of coins) {
      out.push({ objectId: c.objectId, version: c.version, digest: c.digest });
      sum += c.balance;
      if (sum >= need) return { payment: out, total: sum };
    }
    throw new Error(`gas: ${owner} holds ${sum} mist SUI, needs ${need}`);
  }
}
