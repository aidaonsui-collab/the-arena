/**
 * Push-distribute basket-yield RWA pots: pro-rata `push_payout` to all $VICEFUN
 * (or configured) coin holders — no Claim/sync.
 *
 * DEFAULT: dry-run only. Live requires ARENA_BASKET_PUSH_LIVE=1.
 * Does NOT hop/spend keeper wallet SUI for DEX — only gas for push PTBs.
 *
 * Env:
 *   ARENA_BASKET_PUSH_VAULT     — required BasketYieldVault object id
 *   ARENA_BASKET_PUSH_LIVE=1    — sign + execute (else dryRunTransactionBlock)
 *   ARENA_BASKET_PUSH_BATCH     — push_payout calls per PTB; default 20
 *   ARENA_BASKET_PUSH_MIN_POT   — skip asset pots below this; default 1
 *   ARENA_VICEFUN_TYPE          — holder coin type (default VICEFUN)
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
  objectFields,
  typeNameOf,
} from "../chain.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";
import { fetchCoinHolders } from "./pushHolderYield.ts";

const DEFAULT_VICEFUN =
  "0x4a6d6f56100e08f8f433fdc62760259e8d7ab91b476a42e138883dfc35ea80ab::vicefun::VICEFUN";
const PUSH_KEY_SUFFIX = "::basket_yield::PushDistributeKey";

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
      if (t.includes(PUSH_KEY_SUFFIX) || t.endsWith("PushDistributeKey")) return true;
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
}> {
  const meta = await objectFields(vaultId);
  if (!meta) throw new Error(`vault not found: ${vaultId}`);
  const m = meta.type.match(/BasketYieldVault<(.+)>$/);
  if (!m) throw new Error(`not a BasketYieldVault: ${meta.type}`);
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

  return { token, quote, lockId, poolId, pots };
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
          target: `${CALL_PKG}::basket_yield::push_payout`,
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

export async function runPushBasketYield() {
  const vaultId = (process.env.ARENA_BASKET_PUSH_VAULT || "").trim();
  if (!vaultId) {
    return { skipped: true, reason: "set ARENA_BASKET_PUSH_VAULT" };
  }
  const live = truthy(process.env.ARENA_BASKET_PUSH_LIVE);
  const dryRun = !live;
  const minPot = BigInt(process.env.ARENA_BASKET_PUSH_MIN_POT || "1");
  const batch = Math.max(1, Number(process.env.ARENA_BASKET_PUSH_BATCH || "20") || 20);
  const viceType = (process.env.ARENA_VICEFUN_TYPE || DEFAULT_VICEFUN).trim();

  const kp = loadSigner();
  const keeper = kp.getPublicKey().toSuiAddress();
  if (live && !(await adminOwnedBy(keeper))) {
    return { keeper, skipped: true, reason: "keeper does not own AdminCap " + ADMIN_CAP };
  }

  const vault = await readVault(vaultId);
  const pushOn = await isPushMode(vaultId);
  if (!pushOn) {
    return {
      keeper,
      vaultId,
      skipped: true,
      reason: "not push mode — call enable_push_distribute first",
      pots: Object.fromEntries(Object.entries(vault.pots).map(([k, v]) => [k, v.toString()])),
    };
  }

  const holders = await fetchCoinHolders(viceType);
  const exclude = new Set<string>([
    normAddr(vaultId),
    normAddr(vault.lockId),
    normAddr(vault.poolId),
  ]);

  const results: unknown[] = [];
  for (const a of ASSETS) {
    const pot = vault.pots[a.kind] ?? 0n;
    if (pot < minPot) {
      results.push({ asset: a.kind, skipped: true, reason: "dust/empty pot", pot: pot.toString() });
      continue;
    }
    results.push(
      await pushAsset({
        vaultId,
        token: vault.token || viceType,
        quote: vault.quote || SUI,
        asset: a.type,
        kind: a.kind,
        pot,
        holders,
        exclude,
        keeper,
        dryRun,
        batch,
      }),
    );
  }

  return {
    keeper,
    callPackage: CALL_PKG,
    adminCap: ADMIN_CAP,
    vaultId,
    token: vault.token,
    quote: vault.quote,
    holderCoin: viceType,
    holdersFetched: holders.length,
    dryRun,
    live,
    results,
  };
}
