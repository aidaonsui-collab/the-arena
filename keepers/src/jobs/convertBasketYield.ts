/**
 * Basket yield convert keeper: for each BasketYieldVault with quote_staging > 0,
 * including vaults created by Instant migrate (same BasketYieldLaunchEvent discovery).
 * take staged Q (usually SUI), hop to basket RWAs proportional to config weights,
 * and deposit_converted_asset per leg.
 *
 * Hop path (same pools/SDKs as settleInstadex):
 *   SUI → USDC (Cetus USDC/SUI) → XAUM|XAGM (Bluefin) | USDY (Cetus)
 *
 * Env:
 *   ARENA_CALL_PACKAGE          — default v12 published-at
 *   ARENA_CONVERT_DRY_RUN=1     — build + dryRunTransactionBlock only
 *   ARENA_CONVERT_MIN_STAGING   — skip vaults below this (mist); default 1_000_000
 *   ARENA_CONVERT_VAULT         — optional single vault id filter
 *   ARENA_CONVERT_WALLET_RWAS=1 — skip DEX hop; deposit RWA coins already in keeper wallet
 *                                 (quote taken is transferred to keeper as rebate)
 */
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

const EVENT_PKGS = [
  CALL_PKG,
  process.env.ARENA_INSTADEX_PACKAGE,
  process.env.ARENA_PACKAGE_ID,
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
};

async function hopSuiToRwa(
  tx: Transaction,
  suiCoin: TransactionObjectArgument,
  assetType: string,
  leftoverTo: string,
  pools: PoolCache,
): Promise<{ coin: TransactionObjectArgument; asset: string }> {
  const kind = assetKind(assetType);
  if (kind === "UNKNOWN") throw new Error("unsupported basket asset: " + assetType);
  if (!pools.usdcSui) pools.usdcSui = await poolSnap(USDC_SUI_POOL);
  const usdcCoin = cetusHop(tx, pools.usdcSui, SUI, suiCoin, leftoverTo);
  if (kind === "USDY") {
    if (!pools.usdyUsdc) pools.usdyUsdc = await poolSnap(USDY_USDC_POOL);
    return { coin: cetusHop(tx, pools.usdyUsdc, USDC, usdcCoin, leftoverTo), asset: USDY };
  }
  if (kind === "XAGM") {
    if (!pools.xagmUsdc) pools.xagmUsdc = await poolSnap(XAGM_USDC_POOL);
    return {
      coin: bluefinHop(tx, pools.xagmUsdc, USDC, usdcCoin, 1n, leftoverTo),
      asset: XAGM,
    };
  }
  if (!pools.xaumUsdc) pools.xaumUsdc = await poolSnap(XAUM_USDC_POOL);
  return {
    coin: bluefinHop(tx, pools.xaumUsdc, USDC, usdcCoin, 1n, leftoverTo),
    asset: XAUM,
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
  if (normType(vault.quote) !== SUI && !opts.walletRwas) {
    return {
      vaultId: vault.id,
      skipped: true,
      reason: "non-SUI quote hop not implemented; set ARENA_CONVERT_WALLET_RWAS=1 or extend hop",
      quote: vault.quote,
    };
  }

  const shares = quoteSharesForConvert(vault.assets, vault.equalWeight, amount);
  const legs = vault.assets
    .map((a, i) => ({ asset: canonicalAsset(a.asset), share: shares[i] ?? 0n, index: i }))
    .filter((l) => l.share > 0n);
  if (!legs.length) {
    return { vaultId: vault.id, skipped: true, reason: "all quote shares are zero" };
  }

  const tx = new Transaction();
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

  const legCoins: { asset: string; coin: TransactionObjectArgument; quoteSpent: bigint }[] = [];

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
      legCoins.push({ asset: leg.asset, coin, quoteSpent: leg.share });
    }
  } else {
    // Split quote into weight shares; last coin retains remainder after splitCoins.
    const splitAmts = legs.slice(0, -1).map((l) => l.share);
    let parts: TransactionObjectArgument[] = [];
    if (splitAmts.length) {
      const split = tx.splitCoins(quoteCoin, splitAmts.map((a) => tx.pure.u64(a)));
      parts = Array.isArray(split) ? [...split] : [split];
    }
    const quoteParts: TransactionObjectArgument[] = [...parts, quoteCoin];
    for (let i = 0; i < legs.length; i++) {
      const hopped = await hopSuiToRwa(tx, quoteParts[i], legs[i].asset, keeper, pools);
      legCoins.push({
        asset: hopped.asset,
        coin: hopped.coin,
        quoteSpent: legs[i].share,
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
    legs: legs.map((l) => ({
      asset: l.asset,
      kind: assetKind(l.asset),
      quoteShare: l.share.toString(),
      hop: opts.walletRwas
        ? "wallet-RWA"
        : assetKind(l.asset) === "USDY"
          ? "SUI→USDC(Cetus)→USDY(Cetus)"
          : `SUI→USDC(Cetus)→${assetKind(l.asset)}(Bluefin)`,
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
      XAUM: "SUI → USDC (Cetus 0x51e8…) → XAUM (Bluefin 0x458f…)",
      XAGM: "SUI → USDC (Cetus 0x51e8…) → XAGM (Bluefin 0x4d3c…)",
      USDY: "SUI → USDC (Cetus 0x51e8…) → USDY (Cetus 0xdcd7…)",
    },
    stubbed: [
      "Non-SUI quote vaults require ARENA_CONVERT_WALLET_RWAS=1 (no Q→USDC hop yet).",
      "Slippage is minOut=1 on Bluefin legs (same as settleInstadex); tighten if needed.",
    ],
  };
}
