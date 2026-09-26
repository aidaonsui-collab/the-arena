/**
 * VICE buyback & burn.
 *
 * For each `StoredQuote<Q>` in the Config buyback bag (`BuybackBagKey`), one PTB:
 *   config::withdraw_buyback<Q>(Config, AdminCap, full amount)
 *   → swap Coin<Q> to VICEFUN (7k aggregator; falls back to 7k Q→SUI then the
 *     platform Bluefin VICEFUN/SUI pool, the same route the pad uses)
 *   → launch::burn_from_mint_lock<VICEFUN>(InstadexMintLock<VICEFUN>, coin)
 *
 * The burn is real: the VICEFUN TreasuryCap is wrapped in the shared
 * InstadexMintLock<VICEFUN> and `burn_from_mint_lock` is permissionless, so
 * total supply goes down (no 0x0 transfer). VICEFUN never lands in a wallet.
 *
 * DEFAULT: simulate only (GraphQL simulateTransaction against mainnet state).
 * Nothing is signed or sent unless ARENA_VICE_BURN_LIVE=1.
 *
 * Env:
 *   ARENA_VICE_BURN_LIVE=1        sign + execute (signer must own the AdminCap)
 *   ARENA_VICE_BURN_SLIPPAGE      fraction, default 0.01 (7k min_out and Bluefin min_out)
 *   ARENA_VICE_BURN_MIN_SUI       skip quotes worth less than this in SUI mist; default 50000000 (0.05 SUI)
 *   ARENA_VICE_BURN_ONLY          comma list of quote symbols to process, e.g. "SUI,USDY"
 *   ARENA_VICE_BURN_SENDER        dry-run sender override (default: AdminCap owner)
 *   ARENA_VICE_BURN_FORCE_BLUEFIN=1  skip the direct 7k Q→VICEFUN route; use 7k Q→SUI + Bluefin VICEFUN/SUI
 *   ARENA_VICE_BURN_GAS_BUDGET    default 50000000 (0.05 SUI ceiling per PTB; only gas used is charged)
 *   ARENA_VICEFUN_TYPE / ARENA_VICEFUN_MINT_LOCK / ARENA_VICEFUN_SUI_POOL  overrides
 *   ARENA_BUYBACK_BAG             Bag id override (else discover the BuybackBagKey DF on Config)
 *   SUI_GRAPHQL                   GraphQL endpoint (default mainnet)
 */
import { getQuote, buildTx, Config as SevenKConfig } from "@bluefin-exchange/bluefin7k-aggregator-sdk";
import { Transaction, type TransactionObjectArgument } from "@mysten/sui/transactions";
import { toBase64 } from "@mysten/sui/utils";
import { ADMIN_CAP, CALL_PKG, CONFIG, SUI, gql } from "../chain.ts";
import { bluefinHop, normType, type PoolSnap } from "../clmm.ts";
import { pickGasCoins, referenceGasPrice, resolveWithGraphQL, type GasOpts } from "../gqlResolve.ts";
import { loadSigner } from "../loadSigner.ts";

export const VICEFUN =
  process.env.ARENA_VICEFUN_TYPE ||
  "0x4a6d6f56100e08f8f433fdc62760259e8d7ab91b476a42e138883dfc35ea80ab::vicefun::VICEFUN";
/** Shared InstadexMintLock<VICEFUN>; wraps the VICEFUN TreasuryCap. */
export const VICEFUN_MINT_LOCK =
  process.env.ARENA_VICEFUN_MINT_LOCK ||
  "0x9b4320cd6bb5051abe11339e6b343f20c258a51b759f62d9ee8142028f855a4e";
/** Platform Bluefin VICEFUN/SUI pool (index.html ARENA_VICEFUN_SUI_POOL). */
export const VICEFUN_SUI_POOL =
  process.env.ARENA_VICEFUN_SUI_POOL ||
  "0xcae6fe00841fbccb44fbe8128a7c4b2e8800e87c7952af8444d24d0e76eb31c5";
/** Same partner address the pad passes to 7k (commission 0). */
const SEVENK_PARTNER =
  process.env.ARENA_SWAP_PARTNER ||
  "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";
// Oracle-priced sources need Pyth updates over JSON-RPC; keep the route to plain AMMs.
const ORACLE_SOURCES = new Set(["obric", "haedal_pmm", "steamm_oracle_quoter", "steamm_oracle_quoter_v2", "bluefinx"]);

type BagRow = { quote: string; amount: bigint };
type Route = "burn-direct" | "7k" | "7k+bluefin" | "bluefin";
type QuoteResult = {
  quote: string;
  symbol: string;
  amountIn: string;
  suiValue?: string;
  route?: Route;
  expectedVicefun?: string;
  minVicefun?: string;
  simulatedVicefunBurned?: string;
  simulatedGasMist?: string;
  keeperLeftovers?: { coinType: string; amount: string }[];
  status: "skipped" | "simulated" | "sim-failed" | "executed" | "exec-failed";
  reason?: string;
  digest?: string;
};

function truthy(v: string | undefined): boolean {
  return /^(1|true|yes|on)$/i.test(String(v || "").trim());
}
function sym(t: string): string {
  return normType(t).split("::").pop() || t;
}
function eqType(a: string, b: string): boolean {
  const n = (t: string) => normType(t).replace(/^0x0*/, "0x").toLowerCase();
  return n(a) === n(b);
}
function log(...a: unknown[]) {
  console.error("[burn-vice]", ...a);
}

/** 7k's buildTx dry-runs for its own gas estimate and logs when that fails; we set gas ourselves. */
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

async function adminCapOwner(): Promise<string> {
  const d = (await gql(
    `query($id:SuiAddress!){ object(address:$id){ owner{ __typename ... on AddressOwner{ address{ address } } } } }`,
    { id: ADMIN_CAP },
  )) as { object?: { owner?: { address?: { address?: string } } } };
  const a = d.object?.owner?.address?.address;
  if (!a) throw new Error("AdminCap owner not found: " + ADMIN_CAP);
  return a;
}

async function discoverBagId(): Promise<string> {
  const env = (process.env.ARENA_BUYBACK_BAG || "").trim();
  if (env) return env;
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d = (await gql(
      `query($id:SuiAddress!,$after:String){ address(address:$id){ dynamicFields(first:50, after:$after){
        pageInfo{ hasNextPage endCursor } nodes{ name{ type{ repr } } value{ ... on MoveValue{ json } } } } } }`,
      { id: CONFIG, after },
    )) as {
      address: { dynamicFields: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { name: { type: { repr: string } }; value: { json?: { id?: string } } }[] } };
    };
    const conn = d.address.dynamicFields;
    for (const n of conn.nodes) {
      if (/::config::BuybackBagKey$/.test(n.name.type.repr) && n.value?.json?.id) return n.value.json.id;
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  throw new Error("BuybackBagKey dynamic field not found on Config " + CONFIG);
}

async function listBag(bagId: string): Promise<BagRow[]> {
  const out: BagRow[] = [];
  let after: string | null = null;
  for (let i = 0; i < 20; i++) {
    const d = (await gql(
      `query($id:SuiAddress!,$after:String){ address(address:$id){ dynamicFields(first:50, after:$after){
        pageInfo{ hasNextPage endCursor } nodes{ value{ ... on MoveValue{ type{ repr } json } } } } } }`,
      { id: bagId, after },
    )) as {
      address: { dynamicFields: { pageInfo: { hasNextPage: boolean; endCursor: string }; nodes: { value: { type?: { repr: string }; json?: { inner?: string } } }[] } };
    };
    const conn = d.address.dynamicFields;
    for (const n of conn.nodes) {
      const m = String(n.value?.type?.repr || "").match(/::config::StoredQuote<(.+)>$/);
      if (!m) continue;
      out.push({ quote: normType(m[1]), amount: BigInt(n.value?.json?.inner || "0") });
    }
    if (!conn.pageInfo.hasNextPage) break;
    after = conn.pageInfo.endCursor;
  }
  return out;
}

async function sevenKQuote(tokenIn: string, tokenOut: string, amountIn: bigint) {
  try {
    const q = (await getQuote({ tokenIn, tokenOut, amountIn: amountIn.toString() })) as any;
    if (!q || !q.routes?.length || !(BigInt(q.returnAmountWithDecimal || "0") > 0n)) return null;
    const srcs = new Set<string>((q.swaps || []).map((s: any) => String(s?.pool?.type || "").toLowerCase()));
    for (const s of srcs) if (ORACLE_SOURCES.has(s)) return null;
    return q;
  } catch (e) {
    log(`7k quote ${sym(tokenIn)}→${sym(tokenOut)} failed: ${(e as Error).message}`);
    return null;
  }
}

async function vicefunPoolSnap(): Promise<PoolSnap> {
  const d = (await gql(`query($id:SuiAddress!){ object(address:$id){ asMoveObject{ contents{ type{ repr } } } } }`, {
    id: VICEFUN_SUI_POOL,
  })) as { object?: { asMoveObject?: { contents?: { type?: { repr?: string } } } } };
  const type = String(d.object?.asMoveObject?.contents?.type?.repr || "");
  const m = type.match(/::pool::Pool<(.+),\s*(.+)>$/);
  if (!m) throw new Error("VICEFUN pool type unreadable: " + type);
  return { id: VICEFUN_SUI_POOL, type, a: normType(m[1]), b: normType(m[2]) };
}

type Plan = { route: Route; q1?: any; q2?: any; expected: bigint };

async function planRoute(quote: string, amount: bigint): Promise<Plan | { skip: string }> {
  if (eqType(quote, VICEFUN)) return { route: "burn-direct", expected: amount };
  const direct = truthy(process.env.ARENA_VICE_BURN_FORCE_BLUEFIN) ? null : await sevenKQuote(quote, VICEFUN, amount);
  if (direct) return { route: "7k", q1: direct, expected: BigInt(direct.returnAmountWithDecimal) };
  if (eqType(quote, SUI)) return { route: "bluefin", expected: 0n };
  const toSui = await sevenKQuote(quote, SUI, amount);
  if (!toSui) return { skip: `no 7k route ${sym(quote)}→VICEFUN or ${sym(quote)}→SUI` };
  return { route: "7k+bluefin", q1: toSui, expected: 0n };
}

/** Build the whole withdraw → swap → burn PTB. `bluefinMin` guards the Bluefin leg. */
async function buildBurnTx(
  sender: string,
  row: BagRow,
  plan: Plan,
  slippage: number,
  bluefinMin: bigint,
  gasBudget: bigint,
): Promise<Transaction> {
  let tx = new Transaction();
  tx.setSender(sender);
  const withdrawn = tx.moveCall({
    target: `${CALL_PKG}::config::withdraw_buyback`,
    typeArguments: [row.quote],
    arguments: [tx.object(CONFIG), tx.object(ADMIN_CAP), tx.pure.u64(row.amount)],
  }) as unknown as TransactionObjectArgument;

  let vice: TransactionObjectArgument;
  const commission = { partner: SEVENK_PARTNER, commissionBps: 0 };
  if (plan.route === "burn-direct") {
    vice = withdrawn;
  } else if (plan.route === "7k") {
    const b = await quiet7k(() => buildTx({ quoteResponse: plan.q1, accountAddress: sender, slippage, commission, extendTx: { tx: tx as any, coinIn: withdrawn as any } }));
    tx = (b.tx as unknown as Transaction) || tx;
    if (!b.coinOut) throw new Error("7k returned no output coin");
    vice = b.coinOut as unknown as TransactionObjectArgument;
  } else {
    let suiCoin: TransactionObjectArgument = withdrawn;
    if (plan.route === "7k+bluefin") {
      const b = await quiet7k(() => buildTx({ quoteResponse: plan.q1, accountAddress: sender, slippage, commission, extendTx: { tx: tx as any, coinIn: withdrawn as any } }));
      tx = (b.tx as unknown as Transaction) || tx;
      if (!b.coinOut) throw new Error("7k returned no output coin");
      suiCoin = b.coinOut as unknown as TransactionObjectArgument;
    }
    const snap = await vicefunPoolSnap();
    // Unspent SUI (price-limit leftover) returns to the sender; VICEFUN never does.
    vice = bluefinHop(tx, snap, SUI, suiCoin, bluefinMin, sender);
  }
  tx.moveCall({
    target: `${CALL_PKG}::launch::burn_from_mint_lock`,
    typeArguments: [VICEFUN],
    arguments: [tx.object(VICEFUN_MINT_LOCK), vice],
  });
  tx.setGasBudget(gasBudget);
  return tx;
}

type SimOut = {
  ok: boolean;
  error?: string;
  burned: bigint;
  gas: bigint;
  leftovers: { coinType: string; amount: string }[];
};

async function gasFor(sender: string, budget: bigint, noGas: boolean): Promise<GasOpts> {
  const price = await referenceGasPrice();
  if (noGas) return { price, budget, payment: [] };
  const { payment } = await pickGasCoins(sender, budget);
  return { price, budget, payment };
}

async function simulate(tx: Transaction, sender: string, gas: GasOpts): Promise<SimOut> {
  // Empty payment = checks-off simulation (dev-inspect semantics): the sender need not hold gas.
  const checks = gas.payment.length > 0;
  resolveWithGraphQL(tx, gas);
  const bytes = await tx.build();
  const d = (await gql(
    `query($t:JSON!,$checks:Boolean){ simulateTransaction(transaction:$t, checksEnabled:$checks){ effects{
      status executionError{ message abortCode identifier module{ name } function{ name } }
      gasEffects{ gasSummary{ computationCost storageCost storageRebate } }
      events(first:50){ nodes{ contents{ type{ repr } json } } }
      balanceChanges(first:50){ nodes{ owner{ address } coinType{ repr } amount } } } } }`,
    { t: { bcs: { value: toBase64(bytes) } }, checks },
  )) as any;
  const eff = d.simulateTransaction?.effects;
  if (!eff) return { ok: false, error: "no effects", burned: 0n, gas: 0n, leftovers: [] };
  const ok = eff.status === "SUCCESS";
  let burned = 0n;
  for (const n of eff.events?.nodes || []) {
    if (/::events::InstadexBurnEvent$/.test(n.contents.type.repr)) burned += BigInt(n.contents.json.amount || "0");
  }
  const g = eff.gasEffects?.gasSummary || {};
  const gasUsed = BigInt(g.computationCost || 0) + BigInt(g.storageCost || 0) - BigInt(g.storageRebate || 0);
  const leftovers = (eff.balanceChanges?.nodes || [])
    .filter((b: any) => b.owner?.address && b.owner.address.toLowerCase() === sender.toLowerCase() && !eqType(b.coinType.repr, SUI) && BigInt(b.amount) > 0n)
    .map((b: any) => ({ coinType: b.coinType.repr, amount: b.amount }));
  const ex = eff.executionError;
  const error = ok ? undefined : ex ? `${ex.module?.name || "?"}::${ex.function?.name || "?"} abort ${ex.abortCode ?? ""} ${ex.message || ""}`.trim() : String(eff.status);
  return { ok, error, burned, gas: gasUsed, leftovers };
}

export async function runBuybackBurnVice() {
  const live = truthy(process.env.ARENA_VICE_BURN_LIVE);
  const slippage = Number(process.env.ARENA_VICE_BURN_SLIPPAGE || "0.01");
  if (!(slippage > 0 && slippage < 0.2)) throw new Error("ARENA_VICE_BURN_SLIPPAGE must be in (0, 0.2)");
  const minSui = BigInt(process.env.ARENA_VICE_BURN_MIN_SUI || "50000000");
  const gasBudget = BigInt(process.env.ARENA_VICE_BURN_GAS_BUDGET || "50000000");
  const only = new Set(
    String(process.env.ARENA_VICE_BURN_ONLY || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  );
  // Keep the 7k SDK off public JSON-RPC: it only wants a client for its own gas estimate,
  // which we replace (fixed budget, GraphQL simulation). A stub makes that estimate no-op.
  SevenKConfig.setSuiClient({} as any);

  const capOwner = await adminCapOwner();
  let sender = (process.env.ARENA_VICE_BURN_SENDER || capOwner).trim();
  let signer: ReturnType<typeof loadSigner> | null = null;
  if (live) {
    signer = loadSigner();
    sender = signer.getPublicKey().toSuiAddress();
    if (sender.toLowerCase() !== capOwner.toLowerCase()) {
      return { live, skipped: true, reason: `signer ${sender} does not own AdminCap ${ADMIN_CAP} (owner ${capOwner})` };
    }
  }

  const balQ = (await gql(
    `query($a:SuiAddress!){ address(address:$a){ balance(coinType:"0x2::sui::SUI"){ totalBalance } } }`,
    { a: sender },
  )) as { address?: { balance?: { totalBalance?: string } } };
  const senderSui = BigInt(balQ.address?.balance?.totalBalance || "0");
  const gasReady = senderSui >= gasBudget;
  if (!gasReady) log(`WARN sender ${sender} holds ${senderSui} mist SUI < gas budget ${gasBudget}; live runs will fail until funded`);

  const bagId = await discoverBagId();
  const rows = await listBag(bagId);
  log(`bag ${bagId}: ${rows.map((r) => `${sym(r.quote)}=${r.amount}`).join(" ") || "(empty)"}`);
  const results: QuoteResult[] = [];

  for (const row of rows) {
    const res: QuoteResult = { quote: row.quote, symbol: sym(row.quote), amountIn: row.amount.toString(), status: "skipped" };
    results.push(res);
    if (only.size && !only.has(res.symbol.toUpperCase())) {
      res.reason = "not in ARENA_VICE_BURN_ONLY";
      continue;
    }
    if (row.amount === 0n) {
      res.reason = "zero balance";
      continue;
    }
    try {
      // Dust gate in SUI terms.
      let suiValue: bigint;
      if (eqType(row.quote, SUI)) suiValue = row.amount;
      else if (eqType(row.quote, VICEFUN)) suiValue = minSui; // always burn VICEFUN
      else {
        const v = await sevenKQuote(row.quote, SUI, row.amount);
        if (!v) {
          res.reason = `no 7k route ${res.symbol}→SUI; left in bag`;
          log(`skip ${res.symbol}: ${res.reason}`);
          continue;
        }
        suiValue = BigInt(v.returnAmountWithDecimal);
      }
      res.suiValue = suiValue.toString();
      const plan = await planRoute(row.quote, row.amount);
      if ("skip" in plan) {
        res.reason = plan.skip + "; left in bag";
        log(`skip ${res.symbol}: ${res.reason}`);
        continue;
      }
      res.route = plan.route;
      const dust = suiValue < minSui;

      // Pass 1: simulate with no Bluefin floor to learn the real VICEFUN out.
      const tx0 = await buildBurnTx(sender, row, plan, slippage, 0n, gasBudget);
      const gas = await gasFor(sender, gasBudget, !live);
      const sim0 = await simulate(tx0, sender, gas);
      if (!sim0.ok || sim0.burned === 0n) {
        res.status = "sim-failed";
        res.reason = sim0.error || "simulation burned 0 VICEFUN";
        log(`${res.symbol}: simulation failed: ${res.reason}`);
        continue;
      }
      const expected = plan.route === "7k" ? plan.expected : sim0.burned;
      const floor = (sim0.burned * BigInt(Math.round((1 - slippage) * 1e6))) / 1_000_000n;
      res.expectedVicefun = expected.toString();
      res.minVicefun = floor.toString();

      // Pass 2: the real PTB, with the Bluefin leg floored at simulated out × (1 − slippage).
      const bluefinMin = plan.route === "bluefin" || plan.route === "7k+bluefin" ? floor : 0n;
      const tx1 = await buildBurnTx(sender, row, plan, slippage, bluefinMin, gasBudget);
      const sim1 = await simulate(tx1, sender, gas);
      res.simulatedVicefunBurned = sim1.burned.toString();
      res.simulatedGasMist = sim1.gas.toString();
      res.keeperLeftovers = sim1.leftovers;
      if (!sim1.ok) {
        res.status = "sim-failed";
        res.reason = sim1.error;
        continue;
      }
      if (sim1.leftovers.some((l) => eqType(l.coinType, VICEFUN))) {
        res.status = "sim-failed";
        res.reason = "VICEFUN would land in the sender wallet; refusing";
        continue;
      }
      res.status = "simulated";
      if (dust) {
        res.status = "skipped";
        res.reason = `dust: worth ${suiValue} mist SUI < ARENA_VICE_BURN_MIN_SUI ${minSui}; left in bag`;
        log(`skip ${res.symbol}: ${res.reason} (simulated ${sim1.burned} VICEFUN)`);
        continue;
      }
      log(`${res.symbol}: in ${row.amount} → burn ${sim1.burned} VICEFUN (route ${plan.route}, min ${floor})`);
      if (!live || !signer) continue;

      // tx1 already carries the GraphQL resolver + real gas payment from the simulation.
      const bytes = await tx1.build();
      const { signature } = await signer.signTransaction(bytes);
      const ex = (await gql(
        `mutation($b:Base64!,$s:[Base64!]!){ executeTransaction(transactionDataBcs:$b, signatures:$s){ effects{
          digest status executionError{ message abortCode }
          events(first:50){ nodes{ contents{ type{ repr } json } } } } } }`,
        { b: toBase64(bytes), s: [signature] },
      )) as any;
      const eff = ex.executeTransaction?.effects;
      res.digest = eff?.digest;
      res.status = eff?.status === "SUCCESS" ? "executed" : "exec-failed";
      if (res.status === "executed") {
        let burned = 0n;
        for (const n of eff.events?.nodes || []) {
          if (/::events::InstadexBurnEvent$/.test(n.contents.type.repr)) burned += BigInt(n.contents.json.amount || "0");
        }
        (res as QuoteResult & { vicefunBurned?: string }).vicefunBurned = burned.toString();
      } else res.reason = eff?.executionError?.message || "execution failed";
      log(`${res.symbol}: ${res.status} digest ${res.digest}`);
    } catch (e) {
      res.status = res.status === "skipped" ? "sim-failed" : res.status;
      res.reason = (e as Error).message;
      log(`${res.symbol}: error ${res.reason}`);
    }
  }

  return {
    job: "burn-vice",
    live,
    sender,
    adminCapOwner: capOwner,
    bag: bagId,
    vicefun: VICEFUN,
    burnVia: `${CALL_PKG}::launch::burn_from_mint_lock (InstadexMintLock ${VICEFUN_MINT_LOCK})`,
    slippage,
    minSuiMist: minSui.toString(),
    gasBudgetMist: gasBudget.toString(),
    senderSuiMist: senderSui.toString(),
    gasReady,
    results,
  };
}
