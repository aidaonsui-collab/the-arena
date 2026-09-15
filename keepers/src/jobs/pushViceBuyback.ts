/**
 * VICEFUN buyback push-distribute scaffold: report funding → plan RWA basket →
 * pro-rata push to $VICEFUN holders (no Claim).
 *
 * DEFAULT: dry-run only. Never auto-spends keeper wallet SUI.
 * Live spend requires explicit gates:
 *   ARENA_VICE_PUSH_LIVE=1
 *   ARENA_VICE_SUI_AMOUNT=<mist>     — wallet SUI to hop (omit/0 = spend none from wallet)
 *   ARENA_VICE_WITHDRAW_BUYBACK=1    — also withdraw Config BuybackBag
 *
 * Env:
 *   ARENA_VICE_PUSH_LIVE=1
 *   ARENA_VICE_PUSH=1              — enable from run-local (still dry unless LIVE+amounts)
 *   ARENA_VICE_SUI_AMOUNT          — explicit wallet SUI mist to spend (default 0)
 *   ARENA_VICE_GAS_RESERVE         — required leftover if spending wallet SUI; default 1500000000
 *   ARENA_VICE_MIN_BUYBACK         — skip live hop if planned spend below this; default 1000000
 *   ARENA_VICE_WITHDRAW_BUYBACK=1  — withdraw_buyback from Config bag
 *   ARENA_BUYBACK_BAG              — Field or Bag id (else discover BuybackBagKey DF)
 *   ARENA_VICE_PUSH_BATCH          — transfers per PTB; default 20
 *   ARENA_VICE_WALLET_RWAS=1       — skip DEX hop; distribute RWAs already in wallet
 *   ARENA_VICEFUN_TYPE             — holder coin type
 *   ARENA_VICE_BASKET              — e.g. XAUM:4000,XAGM:3000,USDY:3000 (bps); default equal thirds
 */
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import {
  ADMIN_CAP,
  CALL_PKG,
  CONFIG,
  SUI,
  USDC,
  USDC_SUI_POOL,
  USDY,
  USDY_USDC_POOL,
  XAGM,
  XAGM_USDC_POOL,
  XAUM,
  XAUM_USDC_POOL,
  objectFields,
} from "../chain.ts";
import { bluefinHop, cetusHop, normType, poolSnap, type PoolSnap } from "../clmm.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";
import { fetchCoinHolders } from "./pushHolderYield.ts";

const BPS = 10_000n;
const DEFAULT_VICEFUN =
  "0x4a6d6f56100e08f8f433fdc62760259e8d7ab91b476a42e138883dfc35ea80ab::vicefun::VICEFUN";
const DEFAULT_BAG_FIELD =
  "0x31914d64c3c8651eb2f6676c9ab9c6860364a044a3bd284bd8e53d82820b469c";
const DEFAULT_GAS_RESERVE = 1_500_000_000n;

type BagBalance = { quote: string; amount: bigint };
type BasketLeg = { kind: "XAUM" | "XAGM" | "USDY"; asset: string; weightBps: bigint };
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
    if (o.inner != null) return mistOf(o.inner);
    if (o.fields != null) return mistOf(o.fields);
  }
  return 0n;
}

function normAddr(a: string): string {
  const s = String(a || "").toLowerCase();
  if (!s.startsWith("0x")) return `0x${s}`;
  return s;
}

function storedQuoteType(objectType: string): string | null {
  const m = String(objectType || "").match(/::config::StoredQuote<(.+)>$/);
  if (!m) return null;
  return normType(m[1]);
}

function assetKind(asset: string): "XAUM" | "XAGM" | "USDY" | "SUI" | "UNKNOWN" {
  const s = normType(asset);
  if (s === SUI || /::sui::SUI$/i.test(s)) return "SUI";
  if (s === XAUM || /::xaum::XAUM$/i.test(s)) return "XAUM";
  if (s === XAGM || /::xagm::XAGM$/i.test(s)) return "XAGM";
  if (s === USDY || /::usdy::USDY$/i.test(s)) return "USDY";
  return "UNKNOWN";
}

function canonicalAsset(kind: "XAUM" | "XAGM" | "USDY"): string {
  if (kind === "XAUM") return XAUM;
  if (kind === "XAGM") return XAGM;
  return USDY;
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

async function resolveBagId(id: string): Promise<string> {
  const snap = await objectFields(id);
  if (!snap) throw new Error("buyback bag object missing: " + id);
  if (/::bag::Bag$/.test(snap.type) && !/dynamic_field::Field/.test(snap.type)) return id;
  const value = snap.fields.value as { fields?: { id?: { id?: string } } } | undefined;
  const bagId = value?.fields?.id?.id;
  if (bagId) return bagId;
  throw new Error("could not resolve Bag id from " + id + " type=" + snap.type);
}

async function discoverBuybackBagId(): Promise<{ fieldId: string; bagId: string; source: string }> {
  const fromEnv = (process.env.ARENA_BUYBACK_BAG || "").trim();
  if (fromEnv) {
    return { fieldId: fromEnv, bagId: await resolveBagId(fromEnv), source: "env ARENA_BUYBACK_BAG" };
  }
  let cursor: string | null | undefined = null;
  for (let page = 0; page < 10; page++) {
    const res = await client().getDynamicFields({ parentId: CONFIG, cursor, limit: 50 });
    for (const df of res.data || []) {
      const nameType = String((df.name as { type?: string } | undefined)?.type || "");
      if (!/::config::BuybackBagKey$/.test(nameType)) continue;
      const fieldId = df.objectId;
      return { fieldId, bagId: await resolveBagId(fieldId), source: "Config BuybackBagKey DF" };
    }
    if (!res.hasNextPage) break;
    cursor = res.nextCursor;
  }
  return {
    fieldId: DEFAULT_BAG_FIELD,
    bagId: await resolveBagId(DEFAULT_BAG_FIELD),
    source: "default Field id",
  };
}

async function listBagBalances(bagId: string): Promise<BagBalance[]> {
  const out: BagBalance[] = [];
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

function parseBasket(): BasketLeg[] {
  const raw = (process.env.ARENA_VICE_BASKET || "").trim();
  const kinds: ("XAUM" | "XAGM" | "USDY")[] = ["XAUM", "XAGM", "USDY"];
  if (!raw) {
    const base = BPS / 3n;
    const weights = [base, base, BPS - base * 2n];
    return kinds.map((kind, i) => ({ kind, asset: canonicalAsset(kind), weightBps: weights[i] }));
  }
  const map = new Map<string, bigint>();
  for (const part of raw.split(",")) {
    const [k, v] = part.split(":").map((s) => s.trim());
    if (!k || v == null || v === "" || !/^\d+$/.test(v)) continue;
    map.set(k.toUpperCase(), BigInt(v));
  }
  const legs: BasketLeg[] = [];
  for (const kind of kinds) {
    const w = map.get(kind) ?? 0n;
    if (w > 0n) legs.push({ kind, asset: canonicalAsset(kind), weightBps: w });
  }
  if (!legs.length) throw new Error("ARENA_VICE_BASKET parsed empty");
  return legs;
}

function quoteShares(legs: BasketLeg[], quoteAmount: bigint): bigint[] {
  const n = legs.length;
  if (n === 0 || quoteAmount <= 0n) return [];
  const weightSum = legs.reduce((s, l) => s + l.weightBps, 0n);
  if (weightSum <= 0n) return legs.map(() => 0n);
  const shares = legs.map((l) => (quoteAmount * l.weightBps) / weightSum);
  let rem = quoteAmount - shares.reduce((a, b) => a + b, 0n);
  if (rem > 0n) {
    for (let i = n - 1; i >= 0; i--) {
      if (shares[i] > 0n || i === 0) {
        shares[i] += rem;
        break;
      }
    }
  }
  return shares;
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
    const amt = i === eligible.length - 1 ? pot - paid : (pot * h.balance) / supply;
    if (i < eligible.length - 1) paid += amt;
    if (amt > 0n) out.push({ address: h.address, amount: amt });
  }
  return out;
}

type PoolCache = {
  usdcSui?: PoolSnap;
  xaumUsdc?: PoolSnap;
  xagmUsdc?: PoolSnap;
  usdyUsdc?: PoolSnap;
};

async function hopSuiToRwa(
  tx: Transaction,
  suiCoin: TransactionObjectArgument,
  kind: "XAUM" | "XAGM" | "USDY",
  leftoverTo: string,
  pools: PoolCache,
): Promise<{ coin: TransactionObjectArgument; asset: string }> {
  if (!pools.usdcSui) pools.usdcSui = await poolSnap(USDC_SUI_POOL);
  const usdcCoin = cetusHop(tx, pools.usdcSui, SUI, suiCoin, leftoverTo);
  if (kind === "USDY") {
    if (!pools.usdyUsdc) pools.usdyUsdc = await poolSnap(USDY_USDC_POOL);
    return { coin: cetusHop(tx, pools.usdyUsdc, USDC, usdcCoin, leftoverTo), asset: USDY };
  }
  if (kind === "XAGM") {
    if (!pools.xagmUsdc) pools.xagmUsdc = await poolSnap(XAGM_USDC_POOL);
    return { coin: bluefinHop(tx, pools.xagmUsdc, USDC, usdcCoin, 1n, leftoverTo), asset: XAGM };
  }
  if (!pools.xaumUsdc) pools.xaumUsdc = await poolSnap(XAUM_USDC_POOL);
  return { coin: bluefinHop(tx, pools.xaumUsdc, USDC, usdcCoin, 1n, leftoverTo), asset: XAUM };
}

async function takeWalletCoin(
  tx: Transaction,
  owner: string,
  coinType: string,
  amount: bigint,
): Promise<TransactionObjectArgument | null> {
  if (amount <= 0n) return null;
  const coins = await client().getCoins({ owner, coinType });
  const usable = (coins.data || []).filter((x) => BigInt(x.balance) > 0n);
  if (!usable.length) return null;
  const total = usable.reduce((a, x) => a + BigInt(x.balance), 0n);
  if (total < amount) return null;
  const primary = tx.object(usable[0].coinObjectId);
  if (usable.length > 1) {
    tx.mergeCoins(primary, usable.slice(1).map((x) => tx.object(x.coinObjectId)));
  }
  if (total === amount) return primary;
  const split = tx.splitCoins(primary, [tx.pure.u64(amount)]);
  return (Array.isArray(split) ? split[0] : split) as TransactionObjectArgument;
}

async function walletBalance(owner: string, coinType: string): Promise<bigint> {
  const coins = await client().getCoins({ owner, coinType });
  return (coins.data || []).reduce((a, x) => a + BigInt(x.balance), 0n);
}

/** Spend exactly `spend` mist from wallet; require total >= spend + gasReserve. */
async function takeExplicitWalletSui(
  tx: Transaction,
  owner: string,
  spend: bigint,
  gasReserve: bigint,
): Promise<TransactionObjectArgument | null> {
  if (spend <= 0n) return null;
  const coins = await client().getCoins({ owner, coinType: SUI });
  const usable = (coins.data || [])
    .filter((x) => BigInt(x.balance) > 0n)
    .sort((a, b) => (BigInt(b.balance) > BigInt(a.balance) ? 1 : -1));
  const total = usable.reduce((a, x) => a + BigInt(x.balance), 0n);
  if (total < spend + gasReserve) return null;
  const primary = tx.object(usable[0].coinObjectId);
  if (usable.length > 1) {
    tx.mergeCoins(primary, usable.slice(1).map((x) => tx.object(x.coinObjectId)));
  }
  const split = tx.splitCoins(primary, [tx.pure.u64(spend)]);
  return (Array.isArray(split) ? split[0] : split) as TransactionObjectArgument;
}

export async function runPushViceBuyback() {
  const live = truthy(process.env.ARENA_VICE_PUSH_LIVE);
  const dryRun = !live;
  const walletRwas = truthy(process.env.ARENA_VICE_WALLET_RWAS);
  const withdrawBuyback = truthy(process.env.ARENA_VICE_WITHDRAW_BUYBACK);
  const minSpend = BigInt(process.env.ARENA_VICE_MIN_BUYBACK || "1000000");
  const gasReserve = BigInt(process.env.ARENA_VICE_GAS_RESERVE || String(DEFAULT_GAS_RESERVE));
  const batch = Math.max(1, Number(process.env.ARENA_VICE_PUSH_BATCH || "20") || 20);
  const vicefunType = normType(process.env.ARENA_VICEFUN_TYPE || DEFAULT_VICEFUN);

  // Explicit gate: never auto-spend wallet SUI. Default 0.
  const amountRaw = (process.env.ARENA_VICE_SUI_AMOUNT || "").trim();
  const walletSpend =
    amountRaw && /^\d+$/.test(amountRaw) ? BigInt(amountRaw) : 0n;

  const kp = loadSigner();
  const keeper = kp.getPublicKey().toSuiAddress();
  const walletSui = await walletBalance(keeper, SUI);

  if (live && withdrawBuyback && !(await adminOwnedBy(keeper))) {
    return {
      keeper,
      skipped: true,
      reason: "keeper does not own AdminCap " + ADMIN_CAP,
      dryRun,
    };
  }
  if (live && walletSpend > 0n && walletSui < walletSpend + gasReserve) {
    return {
      keeper,
      skipped: true,
      reason: "wallet SUI < ARENA_VICE_SUI_AMOUNT + gas reserve",
      walletSui: walletSui.toString(),
      walletSpend: walletSpend.toString(),
      gasReserve: gasReserve.toString(),
      dryRun,
    };
  }

  let buyback: Record<string, unknown> | null = null;
  let bagBalances: BagBalance[] = [];
  let bagSui = 0n;
  let alreadyRwa: BagBalance[] = [];
  try {
    const discovered = await discoverBuybackBagId();
    bagBalances = await listBagBalances(discovered.bagId);
    bagSui = bagBalances.find((b) => assetKind(b.quote) === "SUI")?.amount ?? 0n;
    alreadyRwa = bagBalances.filter((b) => ["XAUM", "XAGM", "USDY"].includes(assetKind(b.quote)));
    buyback = {
      fieldId: discovered.fieldId,
      bagId: discovered.bagId,
      source: discovered.source,
      balances: bagBalances.map((b) => ({
        quote: b.quote,
        amount: b.amount.toString(),
        kind: assetKind(b.quote),
      })),
      suiAmount: bagSui.toString(),
      totalMist: bagBalances.reduce((s, b) => s + b.amount, 0n).toString(),
    };
  } catch (e) {
    buyback = {
      source: "discover-failed: " + (e instanceof Error ? e.message : String(e)),
      balances: [],
      suiAmount: "0",
      totalMist: "0",
    };
  }

  const bagSuiAdded = withdrawBuyback ? bagSui : 0n;
  // For dry-run planning preview, show hypothetical bag+explicit wallet; never imply auto wallet.
  const planWallet = walletSpend;
  const planBag = withdrawBuyback ? bagSui : 0n;
  const spendSui = planWallet + planBag;
  // Illustrative preview only when no explicit spend: show bag SUI as optional source sample.
  const previewSui = spendSui > 0n ? spendSui : bagSui;

  const basket = parseBasket();
  const shares = quoteShares(basket, previewSui > 0n ? previewSui : 0n);
  const plannedLegs = basket.map((leg, i) => ({
    kind: leg.kind,
    asset: leg.asset,
    weightBps: leg.weightBps.toString(),
    quoteShare: (shares[i] ?? 0n).toString(),
    hop: walletRwas
      ? "wallet-RWA"
      : leg.kind === "USDY"
        ? "SUI→USDC(Cetus)→USDY(Cetus)"
        : `SUI→USDC(Cetus)→${leg.kind}(Bluefin)`,
  }));

  const holders = await fetchCoinHolders(vicefunType);
  const exclude = new Set<string>([normAddr(keeper), normAddr(CONFIG), "0x0"]);
  const sampleAsset = basket[0]?.asset || XAUM;
  const samplePot = (shares[0] && shares[0] > 0n ? shares[0] : previewSui) || 1n;
  const samplePayouts = proRata(samplePot, holders, exclude).slice(0, 5);

  const funding = {
    walletSuiObserved: walletSui.toString(),
    walletSpendExplicit: walletSpend.toString(),
    autoSpendWallet: false,
    gasReserve: gasReserve.toString(),
    withdrawBuyback,
    bagSuiAdded: bagSuiAdded.toString(),
    plannedSpendSui: spendSui.toString(),
    previewBasketSui: previewSui.toString(),
    note: "Wallet SUI is never auto-spent. Set ARENA_VICE_SUI_AMOUNT explicitly to spend any.",
  };

  const base = {
    keeper,
    callPackage: CALL_PKG,
    config: CONFIG,
    adminCap: ADMIN_CAP,
    dryRun,
    live,
    walletRwas,
    minSpend: minSpend.toString(),
    batch,
    vicefunType,
    funding,
    buyback,
    basket: plannedLegs,
    holdersFetched: holders.length,
    samplePayouts: samplePayouts.map((p) => ({
      address: p.address,
      amount: p.amount.toString(),
      asset: sampleAsset,
    })),
    hops: {
      XAUM: "SUI → USDC (Cetus) → XAUM (Bluefin)",
      XAGM: "SUI → USDC (Cetus) → XAGM (Bluefin)",
      USDY: "SUI → USDC (Cetus) → USDY (Cetus)",
    },
  };

  if (dryRun) {
    return {
      ...base,
      phase: "dry-run",
      note:
        "Dry-run scaffold only. No hop/transfer. Live requires ARENA_VICE_PUSH_LIVE=1 plus " +
        "ARENA_VICE_SUI_AMOUNT and/or ARENA_VICE_WITHDRAW_BUYBACK=1. Wallet balance is reported, not spent.",
      alreadyRwa: alreadyRwa.map((b) => ({ quote: b.quote, amount: b.amount.toString() })),
    };
  }

  if (spendSui < minSpend && !walletRwas) {
    return {
      ...base,
      skipped: true,
      reason:
        "no funded source for live hop (set ARENA_VICE_SUI_AMOUNT and/or ARENA_VICE_WITHDRAW_BUYBACK=1)",
    };
  }

  const harvestTx = new Transaction();
  harvestTx.setSender(keeper);
  const harvested: { source: string; quote: string; amount: string; action: string }[] = [];
  const rwaCoins: { asset: string; coin: TransactionObjectArgument }[] = [];
  const suiParts: TransactionObjectArgument[] = [];

  if (walletSpend > 0n) {
    const walletCoin = await takeExplicitWalletSui(harvestTx, keeper, walletSpend, gasReserve);
    if (!walletCoin) {
      return { ...base, skipped: true, reason: "explicit wallet SUI take failed" };
    }
    suiParts.push(walletCoin);
    harvested.push({
      source: "wallet-explicit",
      quote: SUI,
      amount: walletSpend.toString(),
      action: walletRwas ? "keep-SUI" : "hop",
    });
  }

  if (withdrawBuyback && bagBalances.length) {
    for (const row of bagBalances) {
      const coin = harvestTx.moveCall({
        target: `${CALL_PKG}::config::withdraw_buyback`,
        typeArguments: [row.quote],
        arguments: [
          harvestTx.object(CONFIG),
          harvestTx.object(ADMIN_CAP),
          harvestTx.pure.u64(row.amount),
        ],
      });
      const kind = assetKind(row.quote);
      if (kind === "SUI") {
        suiParts.push(coin);
        harvested.push({
          source: "buyback-bag",
          quote: row.quote,
          amount: row.amount.toString(),
          action: walletRwas ? "withdraw-to-keeper" : "withdraw+hop",
        });
      } else if (kind === "XAUM" || kind === "XAGM" || kind === "USDY") {
        rwaCoins.push({ asset: canonicalAsset(kind), coin });
        harvested.push({
          source: "buyback-bag",
          quote: row.quote,
          amount: row.amount.toString(),
          action: "withdraw-keep",
        });
      } else {
        harvestTx.transferObjects([coin], keeper);
        harvested.push({
          source: "buyback-bag",
          quote: row.quote,
          amount: row.amount.toString(),
          action: "withdraw-to-keeper",
        });
      }
    }
  }

  let suiCoin: TransactionObjectArgument | null = null;
  if (suiParts.length === 1) suiCoin = suiParts[0];
  else if (suiParts.length > 1) {
    harvestTx.mergeCoins(suiParts[0], suiParts.slice(1));
    suiCoin = suiParts[0];
  }

  const hopShares = quoteShares(basket, spendSui);
  if (suiCoin && !walletRwas) {
    const pools: PoolCache = {};
    pools.usdcSui = await poolSnap(USDC_SUI_POOL);
    for (const leg of basket) {
      if (leg.kind === "XAUM") pools.xaumUsdc = pools.xaumUsdc || (await poolSnap(XAUM_USDC_POOL));
      if (leg.kind === "XAGM") pools.xagmUsdc = pools.xagmUsdc || (await poolSnap(XAGM_USDC_POOL));
      if (leg.kind === "USDY") pools.usdyUsdc = pools.usdyUsdc || (await poolSnap(USDY_USDC_POOL));
    }
    const positive = basket
      .map((leg, i) => ({ leg, share: hopShares[i] ?? 0n }))
      .filter((x) => x.share > 0n);
    if (positive.length) {
      const splitAmts = positive.slice(0, -1).map((x) => x.share);
      let parts: TransactionObjectArgument[] = [];
      if (splitAmts.length) {
        const split = harvestTx.splitCoins(
          suiCoin,
          splitAmts.map((a) => harvestTx.pure.u64(a)),
        );
        parts = splitAmts.map((_, i) => split[i] as TransactionObjectArgument);
      }
      const quoteParts: TransactionObjectArgument[] = [...parts, suiCoin];
      for (let i = 0; i < positive.length; i++) {
        const hopped = await hopSuiToRwa(
          harvestTx,
          quoteParts[i],
          positive[i].leg.kind,
          keeper,
          pools,
        );
        rwaCoins.push({ asset: hopped.asset, coin: hopped.coin });
      }
    } else {
      harvestTx.transferObjects([suiCoin], keeper);
    }
  } else if (suiCoin && walletRwas) {
    harvestTx.transferObjects([suiCoin], keeper);
  }

  if (!suiParts.length && !rwaCoins.length && !walletRwas) {
    return {
      ...base,
      skipped: true,
      reason: "live requested but no funding source assembled",
    };
  }

  if (rwaCoins.length) {
    harvestTx.transferObjects(
      rwaCoins.map((c) => c.coin),
      keeper,
    );
  }

  const harvestSent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: harvestTx,
    options: { showEffects: true },
  });
  const harvestResult = {
    digest: harvestSent.digest,
    status: harvestSent.effects?.status?.status,
    harvested,
  };
  if (harvestSent.effects?.status?.status !== "success") {
    return {
      ...base,
      phase: "harvest-failed",
      harvest: harvestResult,
      error: String(harvestSent.effects?.status?.error || "harvest failed"),
    };
  }

  const distributeAssets = [
    ...new Set([
      ...basket.map((l) => l.asset),
      ...alreadyRwa.map((b) => {
        const k = assetKind(b.quote);
        return k === "UNKNOWN" || k === "SUI" ? b.quote : canonicalAsset(k);
      }),
    ]),
  ];

  const distributeResults: unknown[] = [];
  for (const asset of distributeAssets) {
    const pot = await walletBalance(keeper, asset);
    if (pot <= 0n) {
      distributeResults.push({ asset, skipped: true, reason: "zero wallet balance" });
      continue;
    }
    const payouts = proRata(pot, holders, exclude);
    if (!payouts.length) {
      distributeResults.push({
        asset,
        skipped: true,
        reason: "no eligible holders",
        pot: pot.toString(),
        holdersFetched: holders.length,
      });
      continue;
    }
    const digests: string[] = [];
    const errors: string[] = [];
    for (let i = 0; i < payouts.length; i += batch) {
      const chunk = payouts.slice(i, i + batch);
      const tx = new Transaction();
      tx.setSender(keeper);
      const totalChunk = chunk.reduce((s, p) => s + p.amount, 0n);
      const coin = await takeWalletCoin(tx, keeper, asset, totalChunk);
      if (!coin) {
        errors.push("insufficient " + asset + " for chunk starting " + i);
        break;
      }
      const amts = chunk.slice(0, -1).map((p) => p.amount);
      let parts: TransactionObjectArgument[] = [];
      if (amts.length) {
        const split = tx.splitCoins(coin, amts.map((a) => tx.pure.u64(a)));
        parts = amts.map((_, j) => split[j] as TransactionObjectArgument);
      }
      const coins: TransactionObjectArgument[] = [...parts, coin];
      for (let j = 0; j < chunk.length; j++) tx.transferObjects([coins[j]], chunk[j].address);
      try {
        const sent = await client().signAndExecuteTransaction({
          signer: kp,
          transaction: tx,
          options: { showEffects: true },
        });
        digests.push(sent.digest);
        if (sent.effects?.status?.status !== "success") {
          errors.push(String(sent.effects?.status?.error || "exec failed"));
        }
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    distributeResults.push({
      asset,
      pot: pot.toString(),
      payouts: payouts.length,
      sample: payouts.slice(0, 5).map((p) => ({ address: p.address, amount: p.amount.toString() })),
      digests,
      errors: errors.length ? errors : undefined,
    });
  }

  return { ...base, phase: "live", harvest: harvestResult, distribute: distributeResults };
}
