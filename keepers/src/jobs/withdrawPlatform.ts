/**
 * AdminCap: drain Config.treasury (1 SUI launch fees) and Config.platform
 * quote bags into the platform wallet (the keeper).
 */
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { ADMIN_CAP, CALL_PKG, CONFIG, SUI, objectFields } from "../chain.ts";
import { normType } from "../clmm.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";

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
    if (o.inner != null) return mistOf(o.inner);
    if (o.fields != null) return mistOf(o.fields);
  }
  return 0n;
}

function storedQuoteType(objectType: string): string | null {
  const m = String(objectType || "").match(/::config::StoredQuote<(.+)>$/);
  if (!m) return null;
  return normType(m[1]);
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

async function platformBalances(bagId: string): Promise<{ quote: string; amount: bigint }[]> {
  const out: { quote: string; amount: bigint }[] = [];
  let cursor: string | null | undefined = null;
  for (let i = 0; i < 10; i++) {
    const page = await client().getDynamicFields({ parentId: bagId, cursor, limit: 50 });
    for (const df of page.data || []) {
      const quote = storedQuoteType(String(df.objectType || ""));
      if (!quote) continue;
      const obj = await client().getObject({ id: df.objectId, options: { showContent: true } });
      const content = obj.data?.content;
      if (!content || content.dataType !== "moveObject") continue;
      const amount = mistOf((content.fields as { value?: unknown }).value);
      if (amount > 0n) out.push({ quote, amount });
    }
    if (!page.hasNextPage) break;
    cursor = page.nextCursor;
  }
  return out;
}

export async function runWithdrawPlatform() {
  const kp = loadSigner();
  const keeper = kp.getPublicKey().toSuiAddress();
  if (!(await adminOwnedBy(keeper))) {
    return { keeper, skipped: true, reason: "keeper does not own AdminCap " + ADMIN_CAP };
  }

  const cfg = await objectFields(CONFIG);
  if (!cfg) return { keeper, skipped: true, reason: "config missing" };
  const treasury = mistOf(cfg.fields.treasury);
  const bag = cfg.fields.platform;
  const bagId =
    bag && typeof bag === "object"
      ? String(
          ((bag as { fields?: { id?: { id?: unknown } } }).fields?.id?.id as string) ||
            ((bag as { id?: { id?: unknown } }).id?.id as string) ||
            "",
        )
      : "";
  const platform = bagId ? await platformBalances(bagId) : [];

  if (treasury <= 0n && platform.length === 0) {
    return { keeper, skipped: true, reason: "nothing to withdraw", treasury: "0", platform: [] };
  }

  const tx = new Transaction();
  tx.setSender(keeper);
  const coins: { quote: string; amount: string; arg: TransactionObjectArgument }[] = [];

  if (treasury > 0n) {
    const coin = tx.moveCall({
      target: `${CALL_PKG}::config::withdraw_treasury`,
      arguments: [tx.object(CONFIG), tx.object(ADMIN_CAP), tx.pure.u64(treasury)],
    });
    coins.push({ quote: SUI, amount: treasury.toString(), arg: coin });
  }
  for (const row of platform) {
    const coin = tx.moveCall({
      target: `${CALL_PKG}::config::withdraw_platform`,
      typeArguments: [row.quote],
      arguments: [tx.object(CONFIG), tx.object(ADMIN_CAP), tx.pure.u64(row.amount)],
    });
    coins.push({ quote: row.quote, amount: row.amount.toString(), arg: coin });
  }
  tx.transferObjects(
    coins.map((c) => c.arg),
    keeper,
  );

  const sent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
  });
  return {
    keeper,
    digest: sent.digest,
    status: sent.effects?.status?.status,
    treasury: treasury.toString(),
    platform: coins.map((c) => ({ quote: c.quote, amount: c.amount })),
    callPackage: CALL_PKG,
  };
}
