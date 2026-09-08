/**
 * RH StockLockVault watcher (v1: poll + log DepositLocked).
 *
 * Env:
 *   RH_RPC            default https://rpc.mainnet.chain.robinhood.com
 *   RH_VAULT_ADDRESS  StockLockVault on RH Chain (required to poll)
 *   RH_WATCH_POLL_MS  default 15000
 *   RH_WATCH_FROM_BLOCK  optional hex/decimal start block; default "latest"-lookback
 *   RH_WATCH_LOOKBACK    blocks to look back on first poll (default 2000)
 *
 * Event ABI (StockLockVault):
 *   DepositLocked(address indexed token, address indexed depositor,
 *                 uint256 amount, bytes32 suiRecipient, uint256 indexed depositId)
 *   topic0 = 0xcd369024a239038366adb9f97aeb7dc8fd7b4b4ff5aeeaf4d0717a8d4a5e0c6d
 *
 * Next: map logs → attestAndMint / enqueue CLI; watch RedeemBurned → release().
 */
import { STOCKS } from "./config.ts";

export const DEPOSIT_LOCKED_SIGNATURE =
  "DepositLocked(address,address,uint256,bytes32,uint256)";

/** keccak256 of DEPOSIT_LOCKED_SIGNATURE (forge/cast verified). */
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

export const DEFAULT_RH_RPC = "https://rpc.mainnet.chain.robinhood.com";

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
  suiRecipient: string;
  depositId: string;
  ticker?: string;
};

function topicAddress(topic: string): string {
  return ("0x" + topic.slice(-40)).toLowerCase();
}

function hexToBigInt(hex: string): bigint {
  return BigInt(hex);
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

  // data = abi.encode(uint256 amount, bytes32 suiRecipient) — 64 bytes each
  const data = log.data.startsWith("0x") ? log.data.slice(2) : log.data;
  if (data.length < 128) return null;
  const amount = hexToBigInt("0x" + data.slice(0, 64)).toString();
  const suiRecipient = "0x" + data.slice(64, 128);

  const ticker = Object.values(STOCKS).find(
    (s) => s.rhToken && s.rhToken.toLowerCase() === token,
  )?.ticker;

  return {
    txHash: log.transactionHash,
    blockNumber: Number(hexToBigInt(log.blockNumber)),
    token,
    depositor,
    amount,
    suiRecipient,
    depositId,
    ticker,
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

export async function runRhWatcher(cfg: RhWatcherConfig = {}) {
  const rhRpc = cfg.rhRpc ?? process.env.RH_RPC ?? DEFAULT_RH_RPC;
  const vault = (cfg.vaultAddress ?? process.env.RH_VAULT_ADDRESS ?? "").trim();
  const pollMs = cfg.pollMs ?? Number(process.env.RH_WATCH_POLL_MS || 15_000);
  const loop = process.env.RH_WATCH_LOOP === "1" && cfg.once !== true;
  const lookback = Number(process.env.RH_WATCH_LOOKBACK || 2000);

  console.log(
    JSON.stringify(
      {
        status: vault ? "watching" : "idle",
        rhRpc,
        vaultAddress: vault || null,
        pollMs,
        loop,
        depositLockedTopic0: DEPOSIT_LOCKED_TOPIC0,
        depositLockedSignature: DEPOSIT_LOCKED_SIGNATURE,
        knownRhTokens: Object.values(STOCKS).map((s) => ({
          ticker: s.ticker,
          rhToken: s.rhToken || null,
        })),
        note: "v1 polls DepositLocked and logs; does not auto-mint",
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
    }
    fromBlock = tip + 1;
  };

  await pass();

  if (!loop) {
    return {
      ok: true,
      stub: false,
      polled: true,
      events: collected,
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
