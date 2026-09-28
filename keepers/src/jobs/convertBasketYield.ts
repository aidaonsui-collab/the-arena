/**
 * Basket yield convert keeper: for each BasketYieldVault with quote_staging > 0,
 * including vaults created by Instant migrate (same BasketYieldLaunchEvent discovery).
 * take staged Q (usually SUI), hop to basket RWAs proportional to config weights,
 * and deposit_converted_asset per leg.
 *
 * Hop path:
 *   quote → SUI on the pair's own Cetus or Bluefin pool (7k only when there is
 *   no pinned pool, e.g. LOFI) → USDC (Cetus) → XAUM|XAGM (Bluefin) | USDY (Cetus).
 *   A reward leg that is already the pair coin is deposited without a swap.
 *   Two RWA coins hop quote → USDC → the other RWA and skip SUI.
 *
 * Env:
 *   ARENA_CALL_PACKAGE          — default v13 published-at
 *   ARENA_CONVERT_DRY_RUN=1     — build + dryRunTransactionBlock only
 *   ARENA_CONVERT_MIN_STAGING   — skip vaults below this (mist); default 1_000_000
 *   ARENA_CONVERT_VAULT         — optional single vault id filter
 *   ARENA_CONVERT_WALLET_RWAS=1 — skip DEX hop; deposit RWA coins already in keeper wallet
 *                                 (quote taken is transferred to keeper as rebate)
 */
import { getQuote, buildTx, Config as SevenKConfig } from "@bluefin-exchange/bluefin7k-aggregator-sdk";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import {
  CALL_PKG,
  CLOCK,
  SUI,
  USDC,
  USDC_SUI_POOL,
  USDY,
  USDY_USDC_POOL,
  XAGM,
  XAGM_USDC_POOL,
  XAUM,
  XAUM_USDC_POOL,
  asId,
  gql,
  objectFields,
  typeNameOf,
} from "../chain.ts";
import { bluefinHop, cetusHop, normType, poolSnap, type PoolSnap } from "../clmm.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";

const BPS = 10_000n;
const SEVENK_PARTNER =
  process.env.ARENA_SWAP_PARTNER ||
  "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";
const ORACLE_SOURCES = new Set(["obric", "haedal_pmm", "steamm_oracle_quoter", "steamm_oracle_quoter_v2", "bluefinx"]);

const VICEFUN =
  "0x4a6d6f56100e08f8f433fdc62760259e8d7ab91b476a42e138883dfc35ea80ab::vicefun::VICEFUN";
const AXOL =
  "0xf00eb7ab086967a33c04a853ad960e5c6b0955ef5a47d50b376d83856dc1215e::axol::AXOL";
const MANIFEST =
  "0xc466c28d87b3d5cd34f3d5c088751532d71a38d93a8aae4551dd56272cfb4355::manifest::MANIFEST";
const WAL = "0x356a26eb9e012a68958082340d4c4116e7f55615cf27affcff209cf0ae544f59::wal::WAL";
const DEEP = "0xdeeb7a4662eec9f2f3def03fb937a663dddaa2e215b8078a284d026b7946c270::deep::DEEP";
const NS = "0x5145494a5f5100e645e4b0aa950fa6b68f614e8c59e17bc5ded3495123a79178::ns::NS";
const SCA = "0x7016aae72cfc67f2fadf55769c0a7dd54291a583b63051a5ed71081cce836ac6::sca::SCA";
const BLUE = "0xe1b45a0e641b9955a20aa0ad1c1f4ad86aad8afb07296d4085e349a50e90bdca::blue::BLUE";
const ZUK = "0x42ba9220e980b4819e4df208dd50013d0bbbfde142996e8db1319ac61f879205::zuk::ZUK";

type Pin = { poolId: string; dex: "cetus" | "bluefin"; via: "sui" | "usdc" };
const QUOTE_PINS: { type: string; pin: Pin }[] = [
  { type: VICEFUN, pin: { poolId: "0xcae6fe00841fbccb44fbe8128a7c4b2e8800e87c7952af8444d24d0e76eb31c5", dex: "bluefin", via: "sui" } },
  { type: AXOL, pin: { poolId: "0xde265ef8645c680c71b33805de77ce5261a20c58397d83b3915bdbb3a7209d7e", dex: "cetus", via: "sui" } },
  { type: MANIFEST, pin: { poolId: "0x15a1adef56e1b716c29a6ce7df539fd7b8080da283199c92c6caa6f641a61c3f", dex: "bluefin", via: "sui" } },
  { type: WAL, pin: { poolId: "0xe60bc7ade245b9f35b49686dfab0a18e5ca9176d49bef1b90f60d67d06315ff0", dex: "bluefin", via: "sui" } },
  { type: DEEP, pin: { poolId: "0xe01243f37f712ef87e556afb9b1d03d0fae13f96d324ec912daffc339dfdcbd2", dex: "cetus", via: "sui" } },
  { type: NS, pin: { poolId: "0x763f63cbada3a932c46972c6c6dcf1abd8a9a73331908a1d7ef24c2232d85520", dex: "cetus", via: "sui" } },
  { type: SCA, pin: { poolId: "0x9661cca01a5b9b3536883568fa967a2943e237de11a97976795f5adb293892e9", dex: "cetus", via: "sui" } },
  { type: BLUE, pin: { poolId: "0xde705d4f3ded922b729d9b923be08e1391dd4caeff8496326123934d0fb1c312", dex: "bluefin", via: "sui" } },
  { type: ZUK, pin: { poolId: "0x43067514317fe6cffb22419a0935aae6aa6e5e5bce31e32fcfb34bd80113d2ad", dex: "cetus", via: "sui" } },
  { type: XAUM, pin: { poolId: XAUM_USDC_POOL, dex: "bluefin", via: "usdc" } },
  { type: XAGM, pin: { poolId: XAGM_USDC_POOL, dex: "bluefin", via: "usdc" } },
  { type: USDY, pin: { poolId: USDY_USDC_POOL, dex: "cetus", via: "usdc" } },
];

const EVENT_PKGS = [
  CALL_PKG,
  process.env.ARENA_INSTADEX_PACKAGE,
  process.env.ARENA_PACKAGE_ID,
  // BasketYieldLaunchEvent / Funded type origin (v12)
  "0x1710adbe0293015cac7492b6db0cf871a7af81c5a51cd9d5d99d3aadf9fea161",
].filter(Boolean) as string[];

type BasketLaunch = {
  lockId: string;
  basketId: string;
  poolId: string;
  token: string;
  quote: string;
  payoutMode: number;
  assetCount: number;
};

type BasketAssetCfg = { asset: string; weightBps: number };

type VaultSnap = {
  id: string;
  type: string;
  token: string;
  quote: string;
  lockId: string;
  poolId: string;
  staging: bigint;
  totalRegistered: bigint;
  equalWeight: boolean;
  payoutMode: number;
  assets: BasketAssetCfg[];
};

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(v || "").trim());
}

function balanceValue(raw: unknown): bigint {
  if (raw == null) return 0n;
  if (typeof raw === "string" || typeof raw === "number" || typeof raw === "bigint") {
    return BigInt(raw);
  }
  if (typeof raw === "object") {
    const o = raw as { fields?: { value?: unknown }; value?: unknown };
    if (o.fields?.value != null) return BigInt(String(o.fields.value));
    if (o.value != null) return BigInt(String(o.value));
  }
  return 0n;
}

function parseTypeName(v: unknown): string {
  return normType(typeNameOf(v));
}

function vaultTypeArgs(type: string): [string, string] | null {
  const m = type.match(/::basket_yield::BasketYieldVault<(.+)>$/);
  if (!m) return null;
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
  if (parts.length !== 2) return null;
  return [normType(parts[0]), normType(parts[1])];
}

function assetKind(asset: string): "XAUM" | "XAGM" | "USDY" | "UNKNOWN" {
  const s = normType(asset);
  if (s === XAUM || /::xaum::XAUM$/i.test(s)) return "XAUM";
  if (s === XAGM || /::xagm::XAGM$/i.test(s)) return "XAGM";
  if (s === USDY || /::usdy::USDY$/i.test(s)) return "USDY";
  return "UNKNOWN";
}

function canonicalAsset(asset: string): string {
  const k = assetKind(asset);
  if (k === "XAUM") return XAUM;
  if (k === "XAGM") return XAGM;
  if (k === "USDY") return USDY;
  return normType(asset);
}

/** Weight-proportional shares; remainder (floor dust) goes to the last positive leg. */
export function quoteSharesForConvert(
  assets: BasketAssetCfg[],
  equalWeight: boolean,
  quoteAmount: bigint,
): bigint[] {
  const n = assets.length;
  if (n === 0 || quoteAmount <= 0n) return [];
  const weights: bigint[] = [];
  if (equalWeight) {
    const base = BPS / BigInt(n);
    for (let i = 0; i < n; i++) {
      weights.push(i + 1 === n ? BPS - base * BigInt(n - 1) : base);
    }
  } else {
    for (const a of assets) weights.push(BigInt(a.weightBps || 0));
  }
  const shares = weights.map((w) => (quoteAmount * w) / BPS);
  let sum = shares.reduce((a, b) => a + b, 0n);
  let rem = quoteAmount - sum;
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

async function listBasketLaunches(): Promise<BasketLaunch[]> {
  const q = `query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }`;
  const byId = new Map<string, BasketLaunch>();
  for (const pkg of EVENT_PKGS) {
    const type = `${pkg}::events::BasketYieldLaunchEvent`;
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
        if (!basketId) continue;
        byId.set(basketId, {
          lockId: asId(p.lock_id),
          basketId,
          poolId: asId(p.bluefin_pool_id),
          token: parseTypeName(p.token),
          quote: parseTypeName(p.quote) || SUI,
          payoutMode: Number(p.payout_mode || 0),
          assetCount: Number(p.asset_count || 0),
        });
      }
      if (!data.events?.pageInfo?.hasNextPage || !data.events.pageInfo.endCursor) break;
      after = data.events.pageInfo.endCursor;
    }
  }
  // Secondary: Funded events may surface vaults if Launch indexing missed a pkg.
  for (const pkg of EVENT_PKGS) {
    const type = `${pkg}::events::BasketYieldFundedEvent`;
    let after: string | null = null;
    for (let page = 0; page < 10; page++) {
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
        if (!basketId || byId.has(basketId)) continue;
        byId.set(basketId, {
          lockId: asId(p.lock_id),
          basketId,
          poolId: asId(p.bluefin_pool_id),
          token: "",
          quote: parseTypeName(p.quote) || SUI,
          payoutMode: 0,
          assetCount: 0,
        });
      }
      if (!data.events?.pageInfo?.hasNextPage || !data.events.pageInfo.endCursor) break;
      after = data.events.pageInfo.endCursor;
    }
  }
  return [...byId.values()];
}

function parseAssets(cfgFields: Record<string, unknown>): BasketAssetCfg[] {
  const raw = cfgFields.assets;
  const list = Array.isArray(raw)
    ? raw
    : raw && typeof raw === "object" && Array.isArray((raw as { fields?: unknown }).fields)
      ? ((raw as { fields: unknown[] }).fields as unknown[])
      : [];
  const out: BasketAssetCfg[] = [];
  for (const item of list) {
    const f =
      item && typeof item === "object" && "fields" in (item as object)
        ? ((item as { fields: Record<string, unknown> }).fields || {})
        : ((item || {}) as Record<string, unknown>);
    const asset = parseTypeName(f.asset);
    const weightBps = Number(f.weight_bps ?? 0);
    if (asset) out.push({ asset, weightBps });
  }
  return out;
}

async function loadVault(id: string, hint?: BasketLaunch): Promise<VaultSnap | null> {
  const obj = await objectFields(id);
  if (!obj) return null;
  const args = vaultTypeArgs(obj.type);
  if (!args) return null;
  const [token, quote] = args;
  const f = obj.fields;
  const cfgRaw = f.config;
  const cfgFields =
    cfgRaw && typeof cfgRaw === "object" && "fields" in (cfgRaw as object)
      ? ((cfgRaw as { fields: Record<string, unknown> }).fields || {})
      : ((cfgRaw || {}) as Record<string, unknown>);
  const assets = parseAssets(cfgFields);
  return {
    id,
    type: obj.type,
    token: token || hint?.token || "",
    quote: quote || hint?.quote || SUI,
    lockId: asId(f.lock_id) || hint?.lockId || "",
    poolId: asId(f.bluefin_pool_id) || hint?.poolId || "",
    staging: balanceValue(f.quote_staging),
    totalRegistered: BigInt(String(f.total_registered ?? 0)),
    equalWeight: Boolean(cfgFields.equal_weight),
    payoutMode: Number(cfgFields.payout_mode ?? hint?.payoutMode ?? 0),
    assets,
  };
}

type PoolCache = {
  usdcSui?: PoolSnap;
  xaumUsdc?: PoolSnap;
  xagmUsdc?: PoolSnap;
  usdyUsdc?: PoolSnap;
  byId?: Map<string, PoolSnap>;
};

type HopOut = { tx: Transaction; coin: TransactionObjectArgument; label: string };

function eqType(a: string, b: string): boolean {
  return normType(a).toLowerCase() === normType(b).toLowerCase();
}

function pinFor(quote: string): Pin | null {
  const q = normType(quote);
  return QUOTE_PINS.find((row) => eqType(row.type, q))?.pin ?? null;
}

async function snapOf(pools: PoolCache, id: string): Promise<PoolSnap> {
  if (!pools.byId) pools.byId = new Map();
  const hit = pools.byId.get(id);
  if (hit) return hit;
  const snap = await poolSnap(id);
  pools.byId.set(id, snap);
  return snap;
}

function dexHop(
  tx: Transaction,
  snap: PoolSnap,
  dex: Pin["dex"],
  fromType: string,
  coinIn: TransactionObjectArgument,
  leftoverTo: string,
): TransactionObjectArgument {
  if (dex === "cetus") return cetusHop(tx, snap, fromType, coinIn, leftoverTo);
  return bluefinHop(tx, snap, fromType, coinIn, 1n, leftoverTo);
}

async function quiet7k<T>(fn: () => Promise<T>): Promise<T> {
  const warn = console.warn;
  const logf = console.log;
  console.warn = () => {};
  console.log = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
    console.log = logf;
  }
}

async function hopVia7k(
  tx: Transaction,
  fromType: string,
  toType: string,
  amount: bigint,
  coin: TransactionObjectArgument,
  sender: string,
): Promise<HopOut> {
  SevenKConfig.setSuiClient({} as never);
  const q = (await quiet7k(() =>
    getQuote({ tokenIn: fromType, tokenOut: toType, amountIn: amount.toString() }),
  )) as {
    routes?: unknown[];
    returnAmountWithDecimal?: string;
    swaps?: { pool?: { type?: string } }[];
  } | null;
  if (!q?.routes?.length || !(BigInt(q.returnAmountWithDecimal || "0") > 0n)) {
    throw new Error("no 7k route " + fromType + " → " + toType);
  }
  for (const swap of q.swaps || []) {
    const src = String(swap?.pool?.type || "").toLowerCase();
    if (ORACLE_SOURCES.has(src)) throw new Error("7k route needs an oracle update: " + src);
  }
  const rawSlip = Number(process.env.ARENA_CONVERT_SLIPPAGE || "0.02");
  const slippage = Number.isFinite(rawSlip) && rawSlip > 0 ? rawSlip : 0.02;
  const built = await quiet7k(() =>
    buildTx({
      quoteResponse: q as never,
      accountAddress: sender,
      slippage,
      commission: { partner: SEVENK_PARTNER, commissionBps: 0 },
      extendTx: { tx: tx as never, coinIn: coin as never },
    }),
  );
  const builtTx = built as unknown as { tx?: Transaction; coinOut?: TransactionObjectArgument };
  const next = builtTx.tx || tx;
  const coinOut = builtTx.coinOut;
  if (!coinOut) throw new Error("7k returned no output coin");
  return { tx: next, coin: coinOut, label: "7k" };
}

async function hopUsdcToRwa(
  tx: Transaction,
  usdcCoin: TransactionObjectArgument,
  assetType: string,
  leftoverTo: string,
  pools: PoolCache,
): Promise<{ coin: TransactionObjectArgument; asset: string }> {
  const kind = assetKind(assetType);
  if (kind === "USDY") {
    if (!pools.usdyUsdc) pools.usdyUsdc = await poolSnap(USDY_USDC_POOL);
    return { coin: cetusHop(tx, pools.usdyUsdc, USDC, usdcCoin, leftoverTo), asset: USDY };
  }
  if (kind === "XAGM") {
    if (!pools.xagmUsdc) pools.xagmUsdc = await poolSnap(XAGM_USDC_POOL);
    return { coin: bluefinHop(tx, pools.xagmUsdc, USDC, usdcCoin, 1n, leftoverTo), asset: XAGM };
  }
  if (kind === "XAUM") {
    if (!pools.xaumUsdc) pools.xaumUsdc = await poolSnap(XAUM_USDC_POOL);
    return { coin: bluefinHop(tx, pools.xaumUsdc, USDC, usdcCoin, 1n, leftoverTo), asset: XAUM };
  }
  throw new Error("unsupported basket asset: " + assetType);
}

async function hopQuoteToSui(
  tx: Transaction,
  quoteType: string,
  coin: TransactionObjectArgument,
  amount: bigint,
  leftoverTo: string,
  pools: PoolCache,
): Promise<HopOut> {
  if (eqType(quoteType, SUI)) return { tx, coin, label: "SUI" };
  const pin = pinFor(quoteType);
  if (!pin) {
    const via = await hopVia7k(tx, quoteType, SUI, amount, coin, leftoverTo);
    return { ...via, label: "7k→SUI" };
  }
  const snap = await snapOf(pools, pin.poolId);
  if (pin.via === "sui") {
    return {
      tx,
      coin: dexHop(tx, snap, pin.dex, quoteType, coin, leftoverTo),
      label: pin.dex === "cetus" ? "Cetus→SUI" : "Bluefin→SUI",
    };
  }
  const usdcCoin = dexHop(tx, snap, pin.dex, quoteType, coin, leftoverTo);
  if (!pools.usdcSui) pools.usdcSui = await poolSnap(USDC_SUI_POOL);
  return {
    tx,
    coin: cetusHop(tx, pools.usdcSui, USDC, usdcCoin, leftoverTo),
    label: "USDC→SUI",
  };
}

async function hopQuoteShareToAsset(
  tx: Transaction,
  quoteType: string,
  coin: TransactionObjectArgument,
  assetType: string,
  amount: bigint,
  leftoverTo: string,
  pools: PoolCache,
): Promise<HopOut & { asset: string }> {
  if (eqType(quoteType, assetType)) {
    return { tx, coin, asset: normType(assetType), label: "same-coin" };
  }
  const qKind = assetKind(quoteType);
  if (qKind !== "UNKNOWN" && assetKind(assetType) !== "UNKNOWN") {
    const pin = pinFor(quoteType);
    if (!pin || pin.via !== "usdc") throw new Error("RWA quote has no USDC pool: " + quoteType);
    const snap = await snapOf(pools, pin.poolId);
    const usdcCoin = dexHop(tx, snap, pin.dex, quoteType, coin, leftoverTo);
    const out = await hopUsdcToRwa(tx, usdcCoin, assetType, leftoverTo, pools);
    return { tx, coin: out.coin, asset: out.asset, label: `${qKind}→USDC→${assetKind(out.asset)}` };
  }
  const sui = await hopQuoteToSui(tx, quoteType, coin, amount, leftoverTo, pools);
  if (!pools.usdcSui) pools.usdcSui = await poolSnap(USDC_SUI_POOL);
  const usdcCoin = cetusHop(sui.tx, pools.usdcSui, SUI, sui.coin, leftoverTo);
  const out = await hopUsdcToRwa(sui.tx, usdcCoin, assetType, leftoverTo, pools);
  const via = eqType(quoteType, SUI) ? "SUI" : sui.label;
  return {
    tx: sui.tx,
    coin: out.coin,
    asset: out.asset,
    label: `${via}→USDC(Cetus)→${assetKind(out.asset)}`,
  };
}

async function takeWalletCoin(
  tx: Transaction,
  owner: string,
  coinType: string,
  minAmount = 1n,
): Promise<TransactionObjectArgument | null> {
  const c = client();
  const coins = await c.getCoins({ owner, coinType });
  const usable = (coins.data || []).filter((x) => BigInt(x.balance) > 0n);
  if (!usable.length) return null;
  const total = usable.reduce((a, x) => a + BigInt(x.balance), 0n);
  if (total < minAmount) return null;
  const primary = tx.object(usable[0].coinObjectId);
  if (usable.length > 1) {
    tx.mergeCoins(
      primary,
      usable.slice(1).map((x) => tx.object(x.coinObjectId)),
    );
  }
  return primary;
}

async function convertOne(
  vault: VaultSnap,
  keeper: string,
  kp: ReturnType<typeof loadSigner>,
  opts: { dryRun: boolean; walletRwas: boolean },
): Promise<Record<string, unknown>> {
  const amount = vault.staging;
  if (amount <= 0n) return { vaultId: vault.id, skipped: true, reason: "empty staging" };
  if (vault.totalRegistered <= 0n) {
    return { vaultId: vault.id, skipped: true, reason: "no registered holders" };
  }
  if (!vault.assets.length) {
    return { vaultId: vault.id, skipped: true, reason: "vault config has no assets" };
  }

  const shares = quoteSharesForConvert(vault.assets, vault.equalWeight, amount);
  const legs = vault.assets
    .map((a, i) => ({ asset: canonicalAsset(a.asset), share: shares[i] ?? 0n, index: i }))
    .filter((l) => l.share > 0n);
  if (!legs.length) {
    return { vaultId: vault.id, skipped: true, reason: "all quote shares are zero" };
  }

  let tx = new Transaction();
  tx.setSender(keeper);

  const quoteCoin = tx.moveCall({
    target: `${CALL_PKG}::basket_yield::take_quote_for_convert`,
    typeArguments: [vault.token, vault.quote],
    arguments: [tx.object(vault.id), tx.pure.u64(amount)],
  });

  const pools: PoolCache = {};
  // Prefetch pool snaps used by legs (wallet mode skips).
  if (!opts.walletRwas) {
    pools.usdcSui = await poolSnap(USDC_SUI_POOL);
    for (const leg of legs) {
      const k = assetKind(leg.asset);
      if (k === "XAUM") pools.xaumUsdc = pools.xaumUsdc || (await poolSnap(XAUM_USDC_POOL));
      if (k === "XAGM") pools.xagmUsdc = pools.xagmUsdc || (await poolSnap(XAGM_USDC_POOL));
      if (k === "USDY") pools.usdyUsdc = pools.usdyUsdc || (await poolSnap(USDY_USDC_POOL));
    }
  }

  const legCoins: { asset: string; coin: TransactionObjectArgument; quoteSpent: bigint; hop: string }[] = [];

  if (opts.walletRwas) {
    // Payment: staging Q goes to keeper; deposit RWAs already held.
    tx.transferObjects([quoteCoin], keeper);
    for (const leg of legs) {
      const coin = await takeWalletCoin(tx, keeper, leg.asset, 1n);
      if (!coin) {
        return {
          vaultId: vault.id,
          skipped: true,
          reason: "wallet missing RWA coin for " + leg.asset,
          asset: leg.asset,
        };
      }
      legCoins.push({ asset: leg.asset, coin, quoteSpent: leg.share, hop: "wallet-RWA" });
    }
  } else {
    // Split quote into weight shares; last coin retains remainder after splitCoins.
    const splitAmts = legs.slice(0, -1).map((l) => l.share);
    let parts: TransactionObjectArgument[] = [];
    if (splitAmts.length) {
      const split = tx.splitCoins(quoteCoin, splitAmts.map((a) => tx.pure.u64(a)));
      parts = splitAmts.map((_, i) => split[i] as TransactionObjectArgument);
    }
    const quoteParts: TransactionObjectArgument[] = [...parts, quoteCoin];
    for (let i = 0; i < legs.length; i++) {
      const hopped = await hopQuoteShareToAsset(
        tx,
        vault.quote,
        quoteParts[i],
        legs[i].asset,
        legs[i].share,
        keeper,
        pools,
      );
      tx = hopped.tx;
      tx.setSender(keeper);
      legCoins.push({
        asset: hopped.asset,
        coin: hopped.coin,
        quoteSpent: legs[i].share,
        hop: hopped.label,
      });
    }
  }

  for (const leg of legCoins) {
    tx.moveCall({
      target: `${CALL_PKG}::basket_yield::deposit_converted_asset`,
      typeArguments: [vault.token, vault.quote, leg.asset],
      arguments: [
        tx.object(vault.id),
        leg.coin,
        tx.pure.u64(leg.quoteSpent),
        tx.object(CLOCK),
      ],
    });
  }

  const built = {
    vaultId: vault.id,
    lockId: vault.lockId,
    staging: amount.toString(),
    legs: legs.map((l, i) => ({
      asset: l.asset,
      kind: assetKind(l.asset),
      quoteShare: l.share.toString(),
      hop: legCoins[i]?.hop || "quote→RWA",
    })),
    equalWeight: vault.equalWeight,
    dryRun: opts.dryRun,
    walletRwas: opts.walletRwas,
    callPackage: CALL_PKG,
  };

  if (opts.dryRun) {
    const dry = await client().dryRunTransactionBlock({
      transactionBlock: await tx.build({ client: client() }),
    });
    return {
      ...built,
      dryRunStatus: dry.effects?.status?.status,
      dryRunError: dry.effects?.status?.error,
      dryRunDigest: dry.effects?.transactionDigest,
    };
  }

  const sent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  const converted: { asset?: string; toAmount?: string; fromAmount?: string }[] = [];
  for (const ev of sent.events || []) {
    const t = String(ev.type || "");
    if (!t.endsWith("::events::BasketYieldConvertedEvent")) continue;
    const p = (ev.parsedJson || {}) as {
      to_asset?: unknown;
      to_amount?: string | number;
      from_amount?: string | number;
    };
    converted.push({
      asset: parseTypeName(p.to_asset),
      toAmount: String(p.to_amount ?? ""),
      fromAmount: String(p.from_amount ?? ""),
    });
  }
  return {
    ...built,
    digest: sent.digest,
    status: sent.effects?.status?.status,
    converted,
  };
}

export async function runConvertBasketYield() {
  const kp = loadSigner();
  const keeper = kp.getPublicKey().toSuiAddress();
  const dryRun = truthy(process.env.ARENA_CONVERT_DRY_RUN);
  const walletRwas = truthy(process.env.ARENA_CONVERT_WALLET_RWAS);
  const minStaging = BigInt(process.env.ARENA_CONVERT_MIN_STAGING || "1000000");
  const onlyVault = (process.env.ARENA_CONVERT_VAULT || "").trim().toLowerCase();

  const launches = await listBasketLaunches();
  if (
    onlyVault &&
    !launches.some(
      (L) => L.basketId.replace(/^0x/, "").toLowerCase() === onlyVault.replace(/^0x/, ""),
    )
  ) {
    launches.push({
      lockId: "",
      basketId: onlyVault.startsWith("0x") ? onlyVault : `0x${onlyVault}`,
      poolId: "",
      token: "",
      quote: SUI,
      payoutMode: 0,
      assetCount: 0,
    });
  }
  const results: unknown[] = [];
  let considered = 0;

  for (const L of launches) {
    if (onlyVault && L.basketId.replace(/^0x/, "").toLowerCase() !== onlyVault.replace(/^0x/, "")) {
      continue;
    }
    let vault: VaultSnap | null = null;
    try {
      vault = await loadVault(L.basketId, L);
    } catch (e) {
      results.push({
        vaultId: L.basketId,
        error: e instanceof Error ? e.message : String(e),
      });
      continue;
    }
    if (!vault) {
      results.push({ vaultId: L.basketId, skipped: true, reason: "vault object missing" });
      continue;
    }
    if (vault.staging < minStaging) {
      results.push({
        vaultId: vault.id,
        skipped: true,
        reason: "below min staging",
        staging: vault.staging.toString(),
        minStaging: minStaging.toString(),
      });
      continue;
    }
    considered++;
    try {
      results.push(await convertOne(vault, keeper, kp, { dryRun, walletRwas }));
    } catch (e) {
      results.push({
        vaultId: vault.id,
        staging: vault.staging.toString(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  return {
    keeper,
    callPackage: CALL_PKG,
    dryRun,
    walletRwas,
    minStaging: minStaging.toString(),
    discovered: launches.length,
    considered,
    results,
    hops: {
      quoteToSui: "pinned Cetus/Bluefin pool, else 7k (LOFI and any unpinned quote)",
      suiToRwa: "SUI → USDC (Cetus) → XAUM|XAGM (Bluefin) | USDY (Cetus)",
      rwaToRwa: "quote USDC pool → the other RWA, skipping SUI",
    },
    stubbed: [
      "Slippage is minOut=1 on Bluefin legs (same as settleInstadex); 7k uses ARENA_CONVERT_SLIPPAGE (default 2%).",
    ],
  };
}
