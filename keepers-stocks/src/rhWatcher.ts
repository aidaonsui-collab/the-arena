/**
 * RH StockLockVault watcher → Sui bridge::mint.
 *
 * Polls DepositLocked on RH Chain, maps token→ticker, and calls the same mint
 * path as the CLI (respects STOCKS_MINT_DRY_RUN / dedupe / u64 limit).
 *
 * Env:
 *   RH_RPC                 default https://rpc.mainnet.chain.robinhood.com
 *   RH_VAULT_ADDRESS       default StockLockVault mainnet (see config)
 *   RH_WATCH_POLL_MS       default 15000
 *   RH_WATCH_FROM_BLOCK    optional hex/decimal start block (overrides the
 *                          persisted cursor in <STOCKS_DATA_DIR>/rh-watch.json)
 *   RH_WATCH_LOOKBACK      blocks to look back on a first-ever poll (default 2000)
 *   RH_WATCH_LOOP=1        continuous poll; otherwise process once and exit
 *   RH_WATCH_BLOCK_TAG     latest|safe|finalized finality ceiling (default safe)
 *   RH_WATCH_CONFIRMATIONS extra blocks below that tag (default 0)
 *   STOCKS_MINT_DRY_RUN=1  dry-run mint (no execute)
 *
 * Finality: minting is irreversible on Sui, so deposits are only minted once
 * they reach the configured ceiling. RH produces ~0.1s blocks and serves
 * L1-anchored `safe` (~12 min behind tip) and `finalized` (~19 min). `latest`
 * restores the old mint-at-tip behaviour and is unsafe without a large
 * RH_WATCH_CONFIRMATIONS.
 *
 * Event ABI (StockLockVault):
 *   DepositLocked(address indexed token, address indexed depositor,
 *                 uint256 amount, bytes32 suiRecipient, uint256 indexed depositId)
 *   topic0 = 0xcd369024a239038366adb9f97aeb7dc8fd7b4b4ff5aeeaf4d0717a8d4a5e0c6d
 */
import {
  DEFAULT_RH_RPC,
  DEFAULT_RH_VAULT_ADDRESS,
  STOCKS,
  U64_MAX,
  RH_TO_SUI_SCALE,
  tickerFromRhToken,
} from "./config.ts";
import { runMint } from "./mint.ts";
import {
  clearPendingMint,
  deadLetteredMints,
  MAX_MINT_ATTEMPTS,
  recordMintFailure,
  retryableMints,
  saveFromBlock,
  savedFromBlock,
} from "./watchStore.ts";

/**
 * Only mint deposits that have reached L1-anchored `safe`. RH `safe` currently
 * trails the tip by ~12 minutes; `finalized` by ~19. Set RH_WATCH_BLOCK_TAG to
 * trade latency against reorg exposure — `latest` restores the old
 * zero-confirmation behaviour and should only be used with a large
 * RH_WATCH_CONFIRMATIONS on a chain you trust not to reorg.
 */
const DEFAULT_BLOCK_TAG: BlockTag = "safe";
/** Depth used when a node does not serve the requested tag (~0.1s blocks). */
const FALLBACK_CONFIRMATIONS = 120;

export const DEPOSIT_LOCKED_SIGNATURE =
  "DepositLocked(address,address,uint256,bytes32,uint256)";

/** keccak256 of DEPOSIT_LOCKED_SIGNATURE (cast verified). */
export const DEPOSIT_LOCKED_TOPIC0 =
  "0xcd369024a239038366adb9f97aeb7dc8fd7b4b4ff5aeeaf4d0717a8d4a5e0c6d";

export const DEPOSIT_LOCKED_ABI = {
  type: "event",
  name: "DepositLocked",
  inputs: [
    { name: "token", type: "address", indexed: true },
    { name: "depositor", type: "address", indexed: true },
    { name: "amount", type: "uint256", indexed: false },
    { name: "suiRecipient", type: "bytes32", indexed: false },
    { name: "depositId", type: "uint256", indexed: true },
  ],
} as const;

export type RhWatcherConfig = {
  rhRpc?: string;
  vaultAddress?: string;
  pollMs?: number;
  /** If true, poll once and return (CLI-friendly). Default: single pass when not RH_WATCH_LOOP=1. */
  once?: boolean;
  /** Finality ceiling for minting. Default `safe`. */
  blockTag?: BlockTag;
  /** Extra depth below the tag. Default 0. */
  confirmations?: number;
};

export type DepositLockedLog = {
  txHash: string;
  blockNumber: number;
  token: string;
  depositor: string;
  amount: string;
  /** Full 32-byte Sui address as 0x + 64 hex. */
  suiRecipient: string;
  depositId: string;
  ticker?: string;
  /** Unique rh_ref: RH tx hash + depositId. */
  rhRef: string;
};

function topicAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
}

/** bytes32 → canonical Sui address (0x + 64 hex). */
export function bytes32ToSuiAddress(bytes32: string): string {
  const h = bytes32.startsWith("0x") ? bytes32.slice(2) : bytes32;
  if (!/^[0-9a-fA-F]{64}$/.test(h)) {
    throw new Error(`suiRecipient must be 32 bytes hex, got ${bytes32}`);
  }
  return ("0x" + h.toLowerCase());
}

/** Unique rh_ref for dedupe: txHash + ":" + depositId. */
export function makeRhRef(txHash: string, depositId: string): string {
  const tx = txHash.startsWith("0x") ? txHash.toLowerCase() : `0x${txHash.toLowerCase()}`;
  return `${tx}:${depositId}`;
}

function decodeDepositLocked(log: {
  address: string;
  topics: string[];
  data: string;
  transactionHash: string;
  blockNumber: string;
}): DepositLockedLog | null {
  if (!log.topics || log.topics.length < 4) return null;
  if (log.topics[0]?.toLowerCase() !== DEPOSIT_LOCKED_TOPIC0.toLowerCase()) return null;

  const token = topicAddress(log.topics[1]);
  const depositor = topicAddress(log.topics[2]);
  const depositId = hexToBigInt(log.topics[3]).toString();

  // data = abi.encode(uint256 amount, bytes32 suiRecipient) — 32 bytes each
  const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (data.length < 128) return null;
  const amount = hexToBigInt("0x" + data.slice(0, 64)).toString();
  const suiRecipient = bytes32ToSuiAddress("0x" + data.slice(64, 128));
  const ticker = tickerFromRhToken(token);
  const txHash = log.transactionHash;

  return {
    txHash,
    blockNumber: Number(hexToBigInt(log.blockNumber)),
    token,
    depositor,
    amount,
    suiRecipient,
    depositId,
    ticker,
    rhRef: makeRhRef(txHash, depositId),
  };
}

async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RH RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`RH RPC: ${body.error.message}`);
  return body.result as T;
}

async function getBlockNumber(rpcUrl: string): Promise<number> {
  const hex = await rpc<string>(rpcUrl, "eth_blockNumber", []);
  return Number(hexToBigInt(hex));
}

/** Block tags RH Chain answers. `safe`/`finalized` are L1-anchored. */
export type BlockTag = "latest" | "safe" | "finalized";

export function parseBlockTag(raw: string | undefined): BlockTag {
  const t = String(raw ?? "").trim().toLowerCase();
  if (t === "latest" || t === "safe" || t === "finalized") return t;
  if (t) throw new Error(`RH_WATCH_BLOCK_TAG must be latest|safe|finalized, got ${raw}`);
  return DEFAULT_BLOCK_TAG;
}

/** Block number behind a tag, or null when the node does not serve it. */
export async function taggedBlockNumber(rpcUrl: string, tag: BlockTag): Promise<number | null> {
  const b = await rpc<{ number?: string } | null>(rpcUrl, "eth_getBlockByNumber", [tag, false]);
  if (!b || !b.number) return null;
  return Number(hexToBigInt(b.number));
}

/**
 * Highest block safe to mint from.
 *
 * The old watcher scanned to `eth_blockNumber` and minted immediately, so a
 * reorg of even one block left an irreversibly minted Sui wrapper with no
 * collateral behind it. RH Chain produces ~0.1s blocks and exposes L1-anchored
 * `safe` / `finalized` tags, so the ceiling is a tag (default `safe`) minus any
 * extra `confirmations`. A fixed depth alone would only cover accidental
 * shallow reorgs, not a sequencer-level reorg — which is the realistic threat
 * on an L2 — so the tag is the primary guard and the depth is a surcharge.
 *
 * Returns null when nothing has reached the required depth yet.
 */
export async function safeCeiling(
  rpcUrl: string,
  tag: BlockTag,
  confirmations: number,
): Promise<{ tip: number; ceiling: number | null; tagBlock: number | null }> {
  const tip = await getBlockNumber(rpcUrl);
  let base = tip;
  let tagBlock: number | null = null;
  if (tag !== "latest") {
    tagBlock = await taggedBlockNumber(rpcUrl, tag);
    if (tagBlock === null) {
      // Node does not serve the tag. Fall back to a depth below the tip rather
      // than silently reverting to zero-confirmation behaviour.
      base = tip - Math.max(confirmations, FALLBACK_CONFIRMATIONS);
      return { tip, tagBlock, ceiling: base >= 0 ? base : null };
    }
    base = Math.min(tagBlock, tip);
  }
  const ceiling = base - confirmations;
  return { tip, tagBlock, ceiling: ceiling >= 0 ? ceiling : null };
}

async function getLogs(
  rpcUrl: string,
  vault: string,
  fromBlock: number,
  toBlock: number,
): Promise<DepositLockedLog[]> {
  const raw = await rpc<
    Array<{
      address: string;
      topics: string[];
      data: string;
      transactionHash: string;
      blockNumber: string;
    }>
  >(rpcUrl, "eth_getLogs", [
    {
      address: vault,
      fromBlock: "0x" + fromBlock.toString(16),
      toBlock: "0x" + toBlock.toString(16),
      topics: [DEPOSIT_LOCKED_TOPIC0],
    },
  ]);
  return (raw ?? []).map(decodeDepositLocked).filter((x): x is DepositLockedLog => !!x);
}

export type MintAttempt = {
  event: DepositLockedLog;
  ok: boolean;
  skipped?: string;
  mint?: unknown;
  error?: string;
};

/**
 * Map a DepositLocked log to bridge::mint (same path as CLI).
 * Skips unknown tokens and amounts that exceed Sui u64.
 */
export async function mintFromDeposit(ev: DepositLockedLog): Promise<MintAttempt> {
  if (!ev.ticker) {
    const msg = `unknown RH token ${ev.token} — not in STOCKS map`;
    console.error(JSON.stringify({ event: "DepositLocked", action: "skip", reason: msg, ...ev }));
    return { event: ev, ok: false, skipped: msg };
  }

  let amountBn: bigint;
  try {
    amountBn = BigInt(ev.amount);
  } catch {
    const msg = `bad amount ${ev.amount}`;
    console.error(JSON.stringify({ event: "DepositLocked", action: "skip", reason: msg, ...ev }));
    return { event: ev, ok: false, skipped: msg };
  }

  if (amountBn <= 0n) {
    const msg = "amount must be > 0";
    console.error(JSON.stringify({ event: "DepositLocked", action: "skip", reason: msg, ...ev }));
    return { event: ev, ok: false, skipped: msg };
  }

  // RH stock tokens are 18dp; the Sui wrappers are 9dp because Sui amounts are
  // u64. Scale down by 1e9. Anything below 1e9 RH base units is under a
  // nano-share and cannot be represented, so it is refused rather than minted
  // as zero — and the remainder above that is dust the redeem does not owe,
  // since release() returns the whole original lock regardless.
  const suiAmountBn = amountBn / RH_TO_SUI_SCALE;
  if (suiAmountBn <= 0n) {
    const msg = `amount ${ev.amount} is below one wrapper unit (${RH_TO_SUI_SCALE} RH base units)`;
    console.error(JSON.stringify({ event: "DepositLocked", action: "skip", reason: msg, ticker: ev.ticker, rhRef: ev.rhRef }));
    return { event: ev, ok: false, skipped: msg };
  }
  if (suiAmountBn > U64_MAX) {
    // Unreachable at 9dp for any real position (~18.4bn shares), kept as a guard.
    const msg = `scaled amount ${suiAmountBn} exceeds u64 max (${U64_MAX})`;
    console.error(JSON.stringify({ event: "DepositLocked", action: "skip", reason: msg, ticker: ev.ticker, rhRef: ev.rhRef }));
    return { event: ev, ok: false, skipped: msg };
  }

  console.log(
    JSON.stringify({
      event: "DepositLocked",
      action: "mint",
      ticker: ev.ticker,
      amount: ev.amount,
      suiAmount: suiAmountBn.toString(),
      recipient: ev.suiRecipient,
      rhRef: ev.rhRef,
      depositId: ev.depositId,
      txHash: ev.txHash,
      dryRunEnv: process.env.STOCKS_MINT_DRY_RUN === "1",
    }),
  );

  try {
    const mint = await runMint({
      ticker: ev.ticker,
      amount: suiAmountBn,
      recipient: ev.suiRecipient,
      rhRef: ev.rhRef,
    });
    console.log(JSON.stringify({ event: "mintResult", rhRef: ev.rhRef, mode: mint.mode, digest: mint.digest ?? null, status: mint.status ?? null }));
    return { event: ev, ok: true, mint };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(JSON.stringify({ event: "mintError", rhRef: ev.rhRef, error }));
    return { event: ev, ok: false, error };
  }
}

export async function runRhWatcher(cfg: RhWatcherConfig = {}) {
  const rhRpc = cfg.rhRpc ?? process.env.RH_RPC ?? DEFAULT_RH_RPC;
  const vault = (
    cfg.vaultAddress ??
    process.env.RH_VAULT_ADDRESS ??
    DEFAULT_RH_VAULT_ADDRESS
  ).trim();
  const pollMs = cfg.pollMs ?? Number(process.env.RH_WATCH_POLL_MS || 15_000);
  const loop = process.env.RH_WATCH_LOOP === "1" && cfg.once !== true;
  const lookback = Number(process.env.RH_WATCH_LOOKBACK || 2000);
  const dryRunDefault = process.env.STOCKS_MINT_DRY_RUN === "1";
  const blockTag = cfg.blockTag ?? parseBlockTag(process.env.RH_WATCH_BLOCK_TAG);
  const confirmations = Number(
    cfg.confirmations ?? process.env.RH_WATCH_CONFIRMATIONS ?? 0,
  );
  if (!Number.isFinite(confirmations) || confirmations < 0) {
    throw new Error(`RH_WATCH_CONFIRMATIONS must be >= 0, got ${process.env.RH_WATCH_CONFIRMATIONS}`);
  }
  if (blockTag === "latest" && confirmations === 0) {
    console.error(
      JSON.stringify({
        flag: "WARN",
        msg: "RH_WATCH_BLOCK_TAG=latest with 0 confirmations mints at the chain tip — a reorg leaves unbacked wrappers on Sui",
      }),
    );
  }

  console.log(
    JSON.stringify(
      {
        status: vault ? "watching" : "idle",
        rhRpc,
        vaultAddress: vault || null,
        pollMs,
        loop,
        dryRunDefault,
        blockTag,
        confirmations,
        pendingRetries: retryableMints().length,
        deadLettered: deadLetteredMints().length,
        depositLockedTopic0: DEPOSIT_LOCKED_TOPIC0,
        depositLockedSignature: DEPOSIT_LOCKED_SIGNATURE,
        knownRhTokens: Object.values(STOCKS).map((s) => ({
          ticker: s.ticker,
          rhToken: s.rhToken || null,
        })),
        note: "auto-mints DepositLocked via bridge::mint (STOCKS_MINT_DRY_RUN=1 to dry-run)",
      },
      null,
      2,
    ),
  );

  if (!vault) {
    return {
      ok: true,
      stub: true,
      reason: "missing RH_VAULT_ADDRESS — set vault address to poll DepositLocked",
      rhRpc,
    };
  }

  let fromBlock: number;
  if (process.env.RH_WATCH_FROM_BLOCK) {
    const raw = process.env.RH_WATCH_FROM_BLOCK;
    fromBlock = raw.startsWith("0x") ? Number(hexToBigInt(raw)) : Number(raw);
  } else {
    // Resume where the last run stopped. Falling back to `tip - lookback` on
    // every start silently skipped anything older than the lookback window.
    const saved = savedFromBlock();
    if (saved !== null) {
      fromBlock = saved;
    } else {
      const tip = await getBlockNumber(rhRpc);
      fromBlock = Math.max(0, tip - lookback);
    }
  }

  const seen = new Set<string>();
  const collected: DepositLockedLog[] = [];
  const attempts: MintAttempt[] = [];

  /**
   * Mint one deposit and file the outcome.
   *
   * `skipped` is a terminal verdict about the deposit itself (unknown token,
   * below one wrapper unit, over u64) — retrying cannot change it, so it leaves
   * the queue. `error` is transient, so it stays queued and the cursor is not
   * allowed to step over it.
   */
  const handle = async (ev: DepositLockedLog): Promise<MintAttempt> => {
    const key = `${ev.txHash}:${ev.depositId}`;
    const attempt = await mintFromDeposit(ev);
    if (attempt.ok || attempt.skipped) {
      clearPendingMint(key);
    } else {
      recordMintFailure(key, ev, attempt.error ?? "unknown mint failure");
    }
    attempts.push(attempt);
    return attempt;
  };

  const pass = async () => {
    const { tip, ceiling, tagBlock } = await safeCeiling(rhRpc, blockTag, confirmations);

    // Retry parked failures first — they are independent of the cursor.
    for (const p of retryableMints()) {
      console.error(
        JSON.stringify({
          event: "mintRetry",
          rhRef: p.event.rhRef,
          attempts: p.attempts,
          lastError: p.lastError,
        }),
      );
      await handle(p.event);
    }
    for (const p of deadLetteredMints()) {
      console.error(
        JSON.stringify({
          event: "mintDeadLetter",
          flag: "NEEDS_OPERATOR",
          rhRef: p.event.rhRef,
          depositId: p.event.depositId,
          ticker: p.event.ticker ?? null,
          amount: p.event.amount,
          attempts: p.attempts,
          lastError: p.lastError,
          note: `gave up after ${MAX_MINT_ATTEMPTS} attempts; collateral is locked with no wrapper — mint manually`,
        }),
      );
    }

    if (ceiling === null || ceiling < fromBlock) {
      console.log(
        JSON.stringify({
          event: "watch",
          status: "waiting-for-finality",
          fromBlock,
          tip,
          tagBlock,
          ceiling,
          blockTag,
          confirmations,
        }),
      );
      return;
    }

    const logs = await getLogs(rhRpc, vault, fromBlock, ceiling);
    for (const ev of logs) {
      const key = `${ev.txHash}:${ev.depositId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(ev);
      console.log(JSON.stringify({ event: "DepositLocked", ...ev }));
      await handle(ev);
    }

    // Safe to advance: anything that failed is parked in the retry queue, so
    // moving the cursor no longer means forgetting it.
    fromBlock = ceiling + 1;
    saveFromBlock(fromBlock);
  };

  try {
    await pass();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[rh-watcher] poll error: ${msg}`);
    if (!loop) {
      return {
        ok: false,
        stub: false,
        polled: false,
        autoMint: true,
        dryRunDefault,
        error: msg,
        events: collected,
        attempts,
        nextFromBlock: fromBlock,
      };
    }
  }

  if (!loop) {
    return {
      ok: true,
      stub: false,
      polled: true,
      autoMint: true,
      dryRunDefault,
      events: collected,
      attempts,
      nextFromBlock: fromBlock,
    };
  }

  console.error(`[rh-watcher] looping every ${pollMs}ms on ${rhRpc} vault ${vault}`);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      await pass();
    } catch (e) {
      console.error(`[rh-watcher] poll error: ${(e as Error).message}`);
    }
  }
}
