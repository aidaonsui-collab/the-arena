/**
 * Push-distribute basket-yield RWA pots. Every basket vault is paid to holders
 * of that vault's own token. A new launch is picked up from its launch event
 * and from the vault currently attached to its lock.
 *
 * DEFAULT: dry-run only. Live requires ARENA_BASKET_PUSH_LIVE=1.
 * Does NOT hop/spend keeper wallet SUI for DEX — only gas for push PTBs.
 *
 * Env:
 *   ARENA_BASKET_PUSH_LIVE=1    — sign + execute (else dryRunTransactionBlock)
 *   ARENA_BASKET_PUSH_VAULT     — optional extra vault id, included with the rest
 *   ARENA_BASKET_PUSH_BATCH     — push_payout calls per PTB; default 20
 *   ARENA_BASKET_PUSH_MIN_POT   — skip asset pots below this; default 1
 *   ARENA_CALL_PACKAGE / ARENA_ADMIN_CAP / ARENA_KEEPER_PHRASE — same as other jobs
 */
import { Transaction } from "@mysten/sui/transactions";
import {
  ADMIN_CAP,
  CALL_PKG,
  CLOCK,
  SUI,
  USDY,
  XAGM,
  XAUM,
  asId,
  gql,
  objectFields,
  typeNameOf,
} from "../chain.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";
import { fetchCoinHolders } from "./pushHolderYield.ts";

const PUSH_KEY_SUFFIXES = ["::basket_yield::PushDistributeKey", "::yield_basket::PushDistributeKey"];
const EVENT_PKGS = [
  CALL_PKG,
  process.env.ARENA_INSTADEX_PACKAGE,
  process.env.ARENA_PACKAGE_ID,
  "0x1710adbe0293015cac7492b6db0cf871a7af81c5a51cd9d5d99d3aadf9fea161",
].filter(Boolean) as string[];

const ASSETS: { kind: "XAUM" | "XAGM" | "USDY"; type: string }[] = [
  { kind: "XAUM", type: XAUM },
  { kind: "XAGM", type: XAGM },
  { kind: "USDY", type: USDY },
];

type HolderRow = { address: string; balance: bigint };

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

function fullyQualifiedType(t: string): string {
  const s = t.trim();
  if (!s.includes("::")) return s.toLowerCase();
  const parts = s.split("::");
  if (parts.length < 3) return s.toLowerCase();
  const addr = parts[0];
  const mod = parts[1];
  const name = parts.slice(2).join("::");
  const hex = (addr.startsWith("0x") ? addr.slice(2) : addr).toLowerCase();
  return `0x${hex.replace(/^0+/, "") || "0"}::${mod}::${name}`;
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

async function isPushMode(vaultId: string): Promise<boolean> {
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 20; page++) {
    const pageRes = await client().getDynamicFields({
      parentId: vaultId,
      cursor: cursor ?? undefined,
    });
    for (const d of pageRes.data ?? []) {
      const name = d.name as { type?: string; value?: unknown };
      const t = String(name?.type || d.objectType || "");
      if (PUSH_KEY_SUFFIXES.some((suffix) => t.includes(suffix)) || t.endsWith("PushDistributeKey")) return true;
    }
    if (!pageRes.hasNextPage || !pageRes.nextCursor) break;
    cursor = pageRes.nextCursor;
  }
  return false;
}

async function readVault(vaultId: string): Promise<{
  token: string;
  quote: string;
  lockId: string;
  poolId: string;
  pots: Record<string, bigint>;
  moduleName: string;
}> {
  const meta = await objectFields(vaultId);
  if (!meta) throw new Error(`vault not found: ${vaultId}`);
  const m = meta.type.match(/(?:BasketYieldVault|YieldBasketVault)<(.+)>$/);
  if (!m) throw new Error(`not a basket vault: ${meta.type}`);
  // parse two type args
  const inner = m[1];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  const token = parts[0] || "";
  const quote = parts[1] || SUI;
  const f = meta.fields;
  const lockId = String((f.lock_id as { id?: string })?.id ?? f.lock_id ?? "");
  const poolId = String((f.bluefin_pool_id as { id?: string })?.id ?? f.bluefin_pool_id ?? "");

  const pots: Record<string, bigint> = {};
  for (const a of ASSETS) {
    pots[a.kind] = 0n;
  }

  // Scan DFs for AssetPotKey — Field wraps AssetPot { bal }; TypeName often omits 0x.
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 20; page++) {
    const df = await client().getDynamicFields({
      parentId: vaultId,
      cursor: cursor ?? undefined,
    });
    for (const d of df.data ?? []) {
      const name = d.name as { type?: string; value?: { asset?: unknown } };
      const nt = String(name?.type || "");
      if (!nt.includes("AssetPotKey")) continue;
      const objectType = String(d.objectType || "");
      const m = objectType.match(/AssetPot<(.+)>$/);
      const assetFromObj = m ? m[1].trim() : "";
      const assetTn = assetFromObj || typeNameOf(name?.value?.asset ?? name?.value);
      const field = await client().getDynamicFieldObject({
        parentId: vaultId,
        name: d.name as { type: string; value: unknown },
      });
      const content = field.data?.content;
      if (!content || content.dataType !== "moveObject") continue;
      const fields = content.fields as {
        bal?: unknown;
        value?: { fields?: { bal?: unknown }; bal?: unknown };
        fields?: { bal?: unknown };
      };
      const bal = mistOf(
        fields?.value?.fields?.bal ?? fields?.value?.bal ?? fields?.bal ?? fields?.fields?.bal,
      );
      const kind = ASSETS.find(
        (a) => fullyQualifiedType(a.type) === fullyQualifiedType(assetTn),
      )?.kind;
      if (kind) pots[kind] = bal;
    }
    if (!df.hasNextPage || !df.nextCursor) break;
    cursor = df.nextCursor;
  }

  const moduleName = meta.type.includes("::yield_basket::") ? "yield_basket" : "basket_yield";
  return { token, quote, lockId, poolId, pots, moduleName };
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
      amt = pot - paid;
    } else {
      amt = (pot * h.balance) / supply;
      paid += amt;
    }
    if (amt > 0n) out.push({ address: h.address, amount: amt });
  }
  return out;
}


async function maybePinGas(tx: Transaction): Promise<void> {
  const gasObj = (process.env.ARENA_GAS_COIN || "").trim();
  if (!gasObj) return;
  const obj = await client().getObject({ id: gasObj, options: { showOwner: true } });
  if (!obj.data) throw new Error("ARENA_GAS_COIN not found: " + gasObj);
  tx.setGasPayment([
    {
      objectId: obj.data.objectId,
      version: obj.data.version,
      digest: obj.data.digest,
    },
  ]);
}

async function pushAsset(opts: {
  vaultId: string;
  token: string;
  quote: string;
  asset: string;
  kind: string;
  pot: bigint;
  holders: HolderRow[];
  exclude: Set<string>;
  keeper: string;
  dryRun: boolean;
  moduleName: string;
  batch: number;
}): Promise<Record<string, unknown>> {
  const payouts = proRata(opts.pot, opts.holders, opts.exclude);
  console.log(
    JSON.stringify({
      asset: opts.kind,
      pot: opts.pot.toString(),
      holders: opts.holders.length,
      payouts: payouts.length,
      sample: payouts.slice(0, 5).map((p) => ({
        address: p.address,
        amount: p.amount.toString(),
      })),
    }),
  );
  if (!payouts.length) {
    return {
      asset: opts.kind,
      skipped: true,
      reason: "no eligible holders",
      pot: opts.pot.toString(),
    };
  }

  const digests: string[] = [];
  const errors: string[] = [];
  for (let i = 0; i < payouts.length; i += opts.batch) {
    const chunk = payouts.slice(i, i + opts.batch);
    // Retry a few times on owned-object version races (AdminCap / gas).
    let attemptOk = false;
    for (let attempt = 0; attempt < 4 && !attemptOk; attempt++) {
      const tx = new Transaction();
      tx.setSender(opts.keeper);
      await maybePinGas(tx);
      for (const p of chunk) {
        tx.moveCall({
          target: `${CALL_PKG}::${opts.moduleName}::push_payout`,
          typeArguments: [opts.token, opts.quote, opts.asset],
          arguments: [
            tx.object(opts.vaultId),
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
          } else {
            attemptOk = true;
          }
        } else {
          const kp = loadSigner();
          const built = await tx.build({ client: client() });
          const sent = await client().signAndExecuteTransaction({
            signer: kp,
            transaction: built,
            options: { showEffects: true },
          });
          digests.push(sent.digest);
          if (sent.effects?.status?.status !== "success") {
            errors.push(String(sent.effects?.status?.error || "exec failed"));
            attemptOk = true; // don't retry failed execution status
          } else {
            await client().waitForTransaction({ digest: sent.digest });
            attemptOk = true;
          }
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const race = /unavailable for consumption|Transaction needs to be rebuilt/i.test(msg);
        if (race && attempt < 3) {
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
          continue;
        }
        errors.push(msg);
        attemptOk = true; // give up this chunk
      }
    }
  }

  return {
    asset: opts.kind,
    pot: opts.pot.toString(),
    payouts: payouts.length,
    digests,
    errors: errors.length ? errors : undefined,
    dryRun: opts.dryRun,
  };
}

async function currentVaultOnLock(lockId: string): Promise<string> {
  try {
    let cursor: string | null | undefined = null;
    for (let page = 0; page < 5; page++) {
      const res = await client().getDynamicFields({ parentId: lockId, cursor, limit: 50 });
      for (const df of res.data || []) {
        const nameType = String((df.name as { type?: string } | undefined)?.type || "");
        if (!/::lock::BasketYieldKey$/.test(nameType)) continue;
        const field = await client().getDynamicFieldObject({
          parentId: lockId,
          name: df.name as { type: string; value: unknown },
        });
        const content = field.data?.content;
        if (!content || content.dataType !== "moveObject") continue;
        const fields = (content.fields || {}) as { value?: unknown };
        let val: unknown = fields.value;
        if (val && typeof val === "object" && "id" in (val as object)) {
          val = (val as { id: unknown }).id;
        }
        const vaultId = asId(val);
        if (vaultId && vaultId !== "0x") return vaultId;
      }
      if (!res.hasNextPage) break;
      cursor = res.nextCursor;
    }
  } catch {
    return "";
  }
  return "";
}

/** Launch events, funded events, the lock's current vault, and an optional extra id. */
async function discoverBasketVaults(): Promise<string[]> {
  const ids = new Set<string>();
  const locks = new Set<string>();
  const extra = (process.env.ARENA_BASKET_PUSH_VAULT || "").trim();
  if (extra) ids.add(asId(extra));
  const q = `query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }`;
  for (const eventName of ["BasketYieldLaunchEvent", "BasketYieldFundedEvent"]) {
    for (const pkg of EVENT_PKGS) {
      const type = `${pkg}::events::${eventName}`;
      let after: string | null = null;
      for (let page = 0; page < 20; page++) {
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
          const basketId = asId(p.basket_id);
          const lockId = asId(p.lock_id);
          if (basketId && basketId !== "0x") ids.add(basketId);
          if (lockId && lockId !== "0x") locks.add(lockId);
        }
        if (!data.events?.pageInfo?.hasNextPage || !data.events.pageInfo.endCursor) break;
        after = data.events.pageInfo.endCursor;
      }
    }
  }
  for (const lockId of locks) {
    const live = await currentVaultOnLock(lockId);
    if (live) ids.add(live);
  }
  return [...ids];
}

export async function runPushBasketYield() {
  const live = truthy(process.env.ARENA_BASKET_PUSH_LIVE);
  const dryRun = !live;
  const minPot = BigInt(process.env.ARENA_BASKET_PUSH_MIN_POT || "1");
  const batch = Math.max(1, Number(process.env.ARENA_BASKET_PUSH_BATCH || "20") || 20);

  const kp = loadSigner();
  const keeper = kp.getPublicKey().toSuiAddress();
  if (live && !(await adminOwnedBy(keeper))) {
    return { keeper, skipped: true, reason: "keeper does not own AdminCap " + ADMIN_CAP };
  }

  const vaultIds = await discoverBasketVaults();
  const holdersByToken = new Map<string, HolderRow[]>();
  const results: unknown[] = [];
  for (const vaultId of vaultIds) {
    try {
      const vault = await readVault(vaultId);
      const pushOn = await isPushMode(vaultId);
      if (!pushOn) {
        results.push({ vaultId, skipped: true, reason: "not push mode" });
        continue;
      }
      const payable = ASSETS.filter((a) => (vault.pots[a.kind] ?? 0n) >= minPot);
      if (!payable.length) {
        results.push({
          vaultId,
          token: vault.token,
          skipped: true,
          reason: "empty pots",
          pots: Object.fromEntries(Object.entries(vault.pots).map(([k, v]) => [k, v.toString()])),
        });
        continue;
      }
      const tokenKey = fullyQualifiedType(vault.token);
      let holders = holdersByToken.get(tokenKey);
      if (!holders) {
        holders = await fetchCoinHolders(vault.token);
        holdersByToken.set(tokenKey, holders);
      }
      const exclude = new Set<string>([
        normAddr(vaultId),
        normAddr(vault.lockId),
        normAddr(vault.poolId),
      ]);
      const assets: unknown[] = [];
      for (const a of ASSETS) {
        const pot = vault.pots[a.kind] ?? 0n;
        if (pot < minPot) continue;
        assets.push(
          await pushAsset({
            vaultId,
            token: vault.token,
            quote: vault.quote || SUI,
            asset: a.type,
            kind: a.kind,
            pot,
            holders,
            exclude,
            keeper,
            dryRun,
            batch,
            moduleName: vault.moduleName,
          }),
        );
      }
      results.push({
        vaultId,
        token: vault.token,
        quote: vault.quote,
        moduleName: vault.moduleName,
        holders: holders.length,
        assets,
      });
    } catch (e) {
      results.push({ vaultId, error: e instanceof Error ? e.message : String(e) });
    }
  }

  return {
    keeper,
    callPackage: CALL_PKG,
    adminCap: ADMIN_CAP,
    vaults: vaultIds.length,
    dryRun,
    live,
    results,
  };
}
