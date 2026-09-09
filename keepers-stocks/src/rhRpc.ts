/**
 * Minimal Robinhood Chain JSON-RPC. Same fetch style as rhWatcher.ts — no ethers.
 * Selectors verified with `cast sig` / `cast sig-event`.
 */
export const GET_LOCK_SELECTOR = "0xd68f4dd1"; // getLock(uint256)
export const RELEASE_SELECTOR = "0x8124fea6"; // release(uint256,address)
export const NEXT_DEPOSIT_ID_SELECTOR = "0x8070a4bd"; // nextDepositId()
export const RELEASED_TOPIC0 =
  "0xbe9955ede01f89429605b39b8541dc3efb42abc6215925c50e35c676e9e06f88";

export type JsonRpcError = { message: string; code?: number; data?: unknown };

export async function rpc<T>(rpcUrl: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  if (!res.ok) throw new Error(`RH RPC HTTP ${res.status}`);
  const body = (await res.json()) as { result?: T; error?: JsonRpcError };
  if (body.error) {
    const extra = body.error.data != null ? ` ${JSON.stringify(body.error.data)}` : "";
    throw new Error(`RH RPC ${method}: ${body.error.message}${extra}`);
  }
  return body.result as T;
}

export function hexToBigInt(hex: string): bigint {
  if (!hex || hex === "0x") return 0n;
  return BigInt(hex);
}

export function toQuantity(n: bigint): string {
  if (n === 0n) return "0x0";
  return "0x" + n.toString(16);
}

export function pad32(hexNoPrefix: string): string {
  return hexNoPrefix.replace(/^0x/, "").padStart(64, "0");
}

export function encodeUint256(n: bigint): string {
  return pad32(n.toString(16));
}

export function encodeAddress(addr: string): string {
  const body = addr.trim().toLowerCase().replace(/^0x/, "");
  if (!/^[0-9a-f]{40}$/.test(body)) throw new Error(`bad address ${addr}`);
  return body.padStart(64, "0");
}

export function topicAddress(word: string): string {
  return ("0x" + word.replace(/^0x/, "").slice(-40)).toLowerCase();
}

export function wordAddress(data: string, wordIndex: number): string {
  const hex = data.replace(/^0x/, "");
  return topicAddress(hex.slice(wordIndex * 64, wordIndex * 64 + 64));
}

export function wordUint(data: string, wordIndex: number): bigint {
  const hex = data.replace(/^0x/, "");
  return hexToBigInt("0x" + (hex.slice(wordIndex * 64, wordIndex * 64 + 64) || "0"));
}

export function wordBytes32(data: string, wordIndex: number): string {
  const hex = data.replace(/^0x/, "");
  return "0x" + hex.slice(wordIndex * 64, wordIndex * 64 + 64);
}

export function encodeReleaseCalldata(depositId: bigint, to: string): string {
  return RELEASE_SELECTOR + encodeUint256(depositId) + encodeAddress(to);
}

export function encodeGetLockCalldata(depositId: bigint): string {
  return GET_LOCK_SELECTOR + encodeUint256(depositId);
}

export type VaultLock = {
  depositId: bigint;
  depositor: string;
  token: string;
  amount: bigint;
  suiRecipient: string;
  released: boolean;
};

export function decodeGetLock(depositId: bigint, data: string): VaultLock | null {
  const hex = (data || "").replace(/^0x/, "");
  if (hex.length < 320) return null;
  const depositor = wordAddress("0x" + hex, 0);
  if (depositor === "0x0000000000000000000000000000000000000000") return null;
  return {
    depositId,
    depositor,
    token: wordAddress("0x" + hex, 1),
    amount: wordUint("0x" + hex, 2),
    suiRecipient: wordBytes32("0x" + hex, 3),
    released: wordUint("0x" + hex, 4) !== 0n,
  };
}

export async function ethCall(
  rpcUrl: string,
  tx: { to: string; data: string; from?: string },
): Promise<string> {
  return rpc<string>(rpcUrl, "eth_call", [
    {
      to: tx.to,
      data: tx.data,
      ...(tx.from ? { from: tx.from } : {}),
    },
    "latest",
  ]);
}

export async function nextDepositId(rpcUrl: string, vault: string): Promise<bigint> {
  const data = await ethCall(rpcUrl, { to: vault, data: NEXT_DEPOSIT_ID_SELECTOR });
  return hexToBigInt(data);
}

export async function getLock(
  rpcUrl: string,
  vault: string,
  depositId: bigint,
): Promise<VaultLock | null> {
  const data = await ethCall(rpcUrl, { to: vault, data: encodeGetLockCalldata(depositId) });
  return decodeGetLock(depositId, data);
}

export async function listLocks(rpcUrl: string, vault: string): Promise<VaultLock[]> {
  const next = await nextDepositId(rpcUrl, vault);
  if (next <= 1n) return [];
  const ids: bigint[] = [];
  for (let id = 1n; id < next; id++) ids.push(id);
  const out: VaultLock[] = [];
  const chunk = 10;
  for (let i = 0; i < ids.length; i += chunk) {
    const slice = ids.slice(i, i + chunk);
    const part = await Promise.all(slice.map((id) => getLock(rpcUrl, vault, id)));
    for (const lock of part) if (lock) out.push(lock);
  }
  return out;
}

export async function simulateRelease(
  rpcUrl: string,
  vault: string,
  from: string,
  depositId: bigint,
  to: string,
): Promise<{ ok: boolean; error?: string }> {
  try {
    await ethCall(rpcUrl, {
      to: vault,
      from,
      data: encodeReleaseCalldata(depositId, to),
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function getBlockNumber(rpcUrl: string): Promise<number> {
  const hex = await rpc<string>(rpcUrl, "eth_blockNumber", []);
  return Number(hexToBigInt(hex));
}
