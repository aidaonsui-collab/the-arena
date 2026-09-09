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
 *   RH_WATCH_FROM_BLOCK    optional hex/decimal start block
 *   RH_WATCH_LOOKBACK      blocks to look back on first poll (default 2000)
 *   RH_WATCH_LOOP=1        continuous poll; otherwise process once and exit
 *   STOCKS_MINT_DRY_RUN=1  dry-run mint (no execute)
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

  console.log(
    JSON.stringify(
      {
        status: vault ? "watching" : "idle",
        rhRpc,
        vaultAddress: vault || null,
        pollMs,
        loop,
        dryRunDefault,
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
    const tip = await getBlockNumber(rhRpc);
    fromBlock = Math.max(0, tip - lookback);
  }

  const seen = new Set<string>();
  const collected: DepositLockedLog[] = [];
  const attempts: MintAttempt[] = [];

  const pass = async () => {
    const tip = await getBlockNumber(rhRpc);
    if (tip < fromBlock) return;
    const logs = await getLogs(rhRpc, vault, fromBlock, tip);
    for (const ev of logs) {
      const key = `${ev.txHash}:${ev.depositId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      collected.push(ev);
      console.log(JSON.stringify({ event: "DepositLocked", ...ev }));
      const attempt = await mintFromDeposit(ev);
      attempts.push(attempt);
    }
    fromBlock = tip + 1;
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
