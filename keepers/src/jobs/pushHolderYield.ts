/**
 * Push-distribute holder-yield: after collect parks Q in push-mode vaults,
 * pro-rata `push_payout` to coin holders (no Claim/sync).
 *
 * Env:
 *   ARENA_CALL_PACKAGE / ARENA_ADMIN_CAP / ARENA_KEEPER_PHRASE — same as other jobs
 *   ARENA_YIELD_PUSH=1           — enable from run-local collect window
 *   ARENA_PUSH_DRY_RUN=1         — log amounts; dryRunTransactionBlock only
 *   ARENA_PUSH_MIN_POT           — skip vaults below this (mist); default 1000
 *   ARENA_PUSH_BATCH             — push_payout calls per PTB; default 20
 *   ARENA_PUSH_VAULT             — optional single vault id
 *   ARENA_HOLDER_YIELD_EVENT_PACKAGE — HolderYieldLaunchEvent package (v11)
 */
import { Transaction } from "@mysten/sui/transactions";
import {
  ADMIN_CAP,
  CALL_PKG,
  CLOCK,
  GQL,
  asId,
  gql,
  objectFields,
  typeNameOf,
} from "../chain.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";

const HY_EVENT_PKG =
  process.env.ARENA_HOLDER_YIELD_EVENT_PACKAGE ??
  "0xe2dee7a21e382d47d8f13e39801c86987a88e9ebd5fb8801efd1b974e4e4d9a2";

const PUSH_KEY_SUFFIX = "::holder_yield::PushDistributeKey";

type HolderRow = { address: string; balance: bigint };
type VaultTarget = {
  lockId: string;
  vaultId: string;
  poolId: string;
  token: string;
  quote: string;
};

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(v || "").trim());
}

function mistOf(v: unknown): bigint {
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
    if (o.value != null) return mistOf(o.value);
    if (o.fields != null) return mistOf(o.fields);
  }
  return 0n;
}

function normAddr(a: string): string {
  const s = String(a || "").toLowerCase();
  if (!s.startsWith("0x")) return `0x${s}`;
  return s;
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

async function listHolderYieldVaults(): Promise<VaultTarget[]> {
  const map = new Map<string, VaultTarget>();
  const types = [
    `${HY_EVENT_PKG}::events::HolderYieldLaunchEvent`,
    `${CALL_PKG}::events::HolderYieldLaunchEvent`,
  ];
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
        const vaultId = asId(p.yield_id);
        if (!lockId || !vaultId) continue;
        map.set(vaultId, {
          lockId,
          vaultId,
          poolId: asId(p.bluefin_pool_id),
          token: typeNameOf(p.token),
          quote: typeNameOf(p.quote),
        });
      }
      if (!data.events?.pageInfo?.hasNextPage || !data.events.pageInfo.endCursor) break;
      after = data.events.pageInfo.endCursor;
    }
  }
  return [...map.values()];
}

async function isPushMode(vaultId: string): Promise<boolean> {
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 5; page++) {
    const res = await client().getDynamicFields({ parentId: vaultId, cursor, limit: 50 });
    for (const df of res.data || []) {
      const nameType = String((df.name as { type?: string } | undefined)?.type || "");
      if (nameType.endsWith(PUSH_KEY_SUFFIX) || /::holder_yield::PushDistributeKey$/.test(nameType)) {
        return true;
      }
    }
    if (!res.hasNextPage) break;
    cursor = res.nextCursor;
  }
  return false;
}

async function rewardPotValue(vaultId: string): Promise<bigint> {
  const snap = await objectFields(vaultId);
  if (!snap) return 0n;
  return mistOf(snap.fields.reward_pot);
}

/** Pool object id → coin_a balance held as liquidity inventory (exclude from pro-rata). */
async function poolCoinABalance(poolId: string): Promise<bigint> {
  if (!poolId) return 0n;
  try {
    const snap = await objectFields(poolId);
    if (!snap) return 0n;
    const f = snap.fields;
    // Bluefin Spot: coin_a is often Balance under fields.coin_a
    const a = mistOf(f.coin_a);
    if (a > 0n) return a;
    return mistOf(f.reserve_x ?? f.balance_a ?? 0);
  } catch {
    return 0n;
  }
}

/**
 * Fetch coin holders via public APIs (best-effort).
 * Order: Suiscan → SuiVision → Mysten GraphQL Coin object scan.
 */
export async function fetchCoinHolders(coinType: string): Promise<HolderRow[]> {
  const type = String(coinType || "").trim();
  if (!type) return [];

  const fromSuiscan = await fetchHoldersSuiscan(type);
  if (fromSuiscan.length) return fromSuiscan;

  const fromVision = await fetchHoldersSuiVision(type);
  if (fromVision.length) return fromVision;

  return fetchHoldersGraphqlCoins(type);
}

async function fetchHoldersSuiscan(coinType: string): Promise<HolderRow[]> {
  const encoded = encodeURIComponent(coinType);
  const urls = [
    `https://suiscan.xyz/api/sui-backend/mainnet/api/coins/${encoded}/holders?page=0&sort=AMOUNT_DESC&size=100`,
    `https://api.suiscan.xyz/mainnet/api/coins/${encoded}/holders?page=0&size=100`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const j = (await r.json()) as unknown;
      const rows = normalizeExplorerHolders(j);
      if (rows.length) return rows;
    } catch {
      /* try next */
    }
  }
  return [];
}

async function fetchHoldersSuiVision(coinType: string): Promise<HolderRow[]> {
  const encoded = encodeURIComponent(coinType);
  const urls = [
    `https://api.suivision.xyz/api/coin/holders?coin_type=${encoded}&page=1&page_size=100`,
    `https://mainnet-api.suivision.xyz/coin/holders?coinType=${encoded}&page=1&size=100`,
  ];
  for (const url of urls) {
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" } });
      if (!r.ok) continue;
      const j = (await r.json()) as unknown;
      const rows = normalizeExplorerHolders(j);
      if (rows.length) return rows;
    } catch {
      /* try next */
    }
  }
  return [];
}

function normalizeExplorerHolders(j: unknown): HolderRow[] {
  const out = new Map<string, bigint>();
  const root = j as Record<string, unknown>;
  const list =
    (Array.isArray(j) ? j : null) ||
    (Array.isArray(root?.content) ? root.content : null) ||
    (Array.isArray(root?.data) ? root.data : null) ||
    (Array.isArray((root?.data as { list?: unknown[] })?.list)
      ? (root.data as { list: unknown[] }).list
      : null) ||
    (Array.isArray(root?.holders) ? root.holders : null) ||
    (Array.isArray(root?.result) ? root.result : null) ||
    [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const o = row as Record<string, unknown>;
    const addr = normAddr(
      String(o.address ?? o.owner ?? o.holder ?? o.account ?? o.wallet ?? ""),
    );
    if (!addr || addr === "0x" || addr === "0x0") continue;
    const bal = mistOf(o.amount ?? o.balance ?? o.quantity ?? o.value ?? o.coinAmount);
    if (bal <= 0n) continue;
    out.set(addr, (out.get(addr) ?? 0n) + bal);
  }
  return [...out.entries()].map(([address, balance]) => ({ address, balance }));
}

/** Aggregate Coin<T> objects from Mysten GraphQL by AddressOwner. */
async function fetchHoldersGraphqlCoins(coinType: string): Promise<HolderRow[]> {
  const typeFilter = `0x2::coin::Coin<${coinType}>`;
  const q = `query($t:String!,$first:Int!,$after:String){
    objects(first:$first, after:$after, filter:{ type:$t }){
      pageInfo { hasNextPage endCursor }
      nodes {
        address
        owner {
          __typename
          ... on AddressOwner { owner { address } }
          ... on Parent { parent { address } }
          ... on Shared { initialSharedVersion }
        }
        asMoveObject { contents { json } }
      }
    }
  }`;
  const by = new Map<string, bigint>();
  let after: string | null = null;
  for (let page = 0; page < 40; page++) {
    let data: {
      objects?: {
        pageInfo?: { hasNextPage?: boolean; endCursor?: string };
        nodes?: {
          address?: string;
          owner?: {
            __typename?: string;
            owner?: { address?: string };
            parent?: { address?: string };
          };
          asMoveObject?: { contents?: { json?: { balance?: unknown; fields?: { balance?: unknown } } } };
        }[];
      };
    };
    try {
      data = (await gql(q, { t: typeFilter, first: 50, after })) as typeof data;
    } catch (e) {
      // Older schema variant
      try {
        const alt = `query($t:String!,$first:Int!,$after:String){
          objects(first:$first, after:$after, filter:{ type:$t }){
            pageInfo { hasNextPage endCursor }
            nodes {
              address
              owner { ... on AddressOwner { owner { address } } }
              asMoveObject { contents { json } }
            }
          }
        }`;
        data = (await gql(alt, { t: typeFilter, first: 50, after })) as typeof data;
      } catch {
        console.warn("graphql coin scan failed", e instanceof Error ? e.message : e);
        break;
      }
    }
    const nodes = data.objects?.nodes ?? [];
    for (const n of nodes) {
      const ownerAddr = n.owner?.owner?.address;
      if (!ownerAddr) continue; // skip shared / object / immutable
      const json = n.asMoveObject?.contents?.json;
      const bal = mistOf(json?.balance ?? json?.fields?.balance);
      if (bal <= 0n) continue;
      const a = normAddr(ownerAddr);
      by.set(a, (by.get(a) ?? 0n) + bal);
    }
    if (!data.objects?.pageInfo?.hasNextPage || !data.objects.pageInfo.endCursor) break;
    after = data.objects.pageInfo.endCursor;
  }
  return [...by.entries()].map(([address, balance]) => ({ address, balance }));
}

function proRata(
  pot: bigint,
  holders: HolderRow[],
  exclude: Set<string>,
): { address: string; amount: bigint }[] {
  const eligible = holders.filter((h) => h.balance > 0n && !exclude.has(normAddr(h.address)));
  const supply = eligible.reduce((s, h) => s + h.balance, 0n);
  if (supply <= 0n || pot <= 0n) return [];
  const out: { address: string; amount: bigint }[] = [];
  let paid = 0n;
  for (let i = 0; i < eligible.length; i++) {
    const h = eligible[i];
    let amt: bigint;
    if (i === eligible.length - 1) {
      amt = pot - paid; // dust to last
    } else {
      amt = (pot * h.balance) / supply;
      paid += amt;
    }
    if (amt > 0n) out.push({ address: h.address, amount: amt });
  }
  return out;
}

async function pushVault(
  v: VaultTarget,
  keeper: string,
  opts: { dryRun: boolean; batch: number; minPot: bigint },
): Promise<Record<string, unknown>> {
  if (!(await isPushMode(v.vaultId))) {
    return { vaultId: v.vaultId, skipped: true, reason: "not push mode" };
  }
  const pot = await rewardPotValue(v.vaultId);
  if (pot < opts.minPot) {
    return { vaultId: v.vaultId, skipped: true, reason: "dust pot", pot: pot.toString() };
  }
  if (!v.token) {
    return { vaultId: v.vaultId, skipped: true, reason: "no token type" };
  }

  const holders = await fetchCoinHolders(v.token);
  const exclude = new Set<string>([
    normAddr(v.vaultId),
    normAddr(v.poolId),
    normAddr(v.lockId),
  ]);
  // Bluefin keeps coin A as Balance inside the pool object (not a Coin owner row).
  // If explorers still list the pool/vault as a "holder", exclude those addresses.
  const poolInv = await poolCoinABalance(v.poolId);
  void poolInv;
  const payouts = proRata(pot, holders, exclude);

  console.log(
    JSON.stringify({
      vaultId: v.vaultId,
      token: v.token,
      pot: pot.toString(),
      holders: holders.length,
      payouts: payouts.length,
      sample: payouts.slice(0, 5).map((p) => ({
        address: p.address,
        amount: p.amount.toString(),
      })),
    }),
  );

  if (!payouts.length) {
    return {
      vaultId: v.vaultId,
      skipped: true,
      reason: "no eligible holders",
      pot: pot.toString(),
      holdersFetched: holders.length,
    };
  }

  const digests: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < payouts.length; i += opts.batch) {
    const chunk = payouts.slice(i, i + opts.batch);
    const tx = new Transaction();
    tx.setSender(keeper);
    for (const p of chunk) {
      tx.moveCall({
        target: `${CALL_PKG}::holder_yield::push_payout`,
        typeArguments: [v.token, v.quote || "0x2::sui::SUI"],
        arguments: [
          tx.object(v.vaultId),
          tx.object(ADMIN_CAP),
          tx.pure.address(p.address),
          tx.pure.u64(p.amount),
          tx.object(CLOCK),
        ],
      });
    }
    try {
      if (opts.dryRun) {
        const dry = await client().dryRunTransactionBlock({
          transactionBlock: await tx.build({ client: client() }),
        });
        digests.push(
          `dry:${dry.effects?.status?.status}:${dry.effects?.transactionDigest ?? ""}`,
        );
        if (dry.effects?.status?.status !== "success") {
          errors.push(String(dry.effects?.status?.error || "dry-run failed"));
        }
      } else {
        const kp = loadSigner();
        const sent = await client().signAndExecuteTransaction({
          signer: kp,
          transaction: tx,
          options: { showEffects: true },
        });
        digests.push(sent.digest);
        if (sent.effects?.status?.status !== "success") {
          errors.push(String(sent.effects?.status?.error || "exec failed"));
        }
      }
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e));
    }
  }

  return {
    vaultId: v.vaultId,
    lockId: v.lockId,
    pot: pot.toString(),
    holdersFetched: holders.length,
    payouts: payouts.length,
    digests,
    errors: errors.length ? errors : undefined,
    dryRun: opts.dryRun,
  };
}

export async function runPushHolderYield() {
  // Default live when signed CLI / run-local with AdminCap. Force dry with ARENA_PUSH_DRY_RUN=1.
  const useDry = truthy(process.env.ARENA_PUSH_DRY_RUN);

  const kp = loadSigner();
  const keeper = kp.getPublicKey().toSuiAddress();
  if (!useDry && !(await adminOwnedBy(keeper))) {
    return { keeper, skipped: true, reason: "keeper does not own AdminCap " + ADMIN_CAP };
  }

  const minPot = BigInt(process.env.ARENA_PUSH_MIN_POT || "1000");
  const batch = Math.max(1, Number(process.env.ARENA_PUSH_BATCH || "20") || 20);
  const only = (process.env.ARENA_PUSH_VAULT || "").trim();

  let vaults = await listHolderYieldVaults();
  if (only) vaults = vaults.filter((v) => v.vaultId === only || v.lockId === only);

  const results: unknown[] = [];
  for (const v of vaults) {
    try {
      results.push(await pushVault(v, keeper, { dryRun: useDry, batch, minPot }));
    } catch (e) {
      results.push({
        vaultId: v.vaultId,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    keeper,
    callPackage: CALL_PKG,
    adminCap: ADMIN_CAP,
    dryRun: useDry,
    graphql: GQL,
    n: vaults.length,
    results,
  };
}
