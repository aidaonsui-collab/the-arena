/**
 * Sign and broadcast StockLockVault.release(depositId, to) on Robinhood Chain.
 * Key is read from RH_RELEASER_KEY only, never logged. Live send is a separate
 * opt-in; this module does not decide dry-run policy.
 *
 * Uses @noble (already a @mysten/sui transitive) for keccak + secp256k1 so the
 * key never appears in a child-process argv (unlike `cast send --private-key`).
 */
import { secp256k1 } from "@noble/curves/secp256k1";
import { keccak_256 } from "@noble/hashes/sha3";
import { RH_CHAIN_ID } from "./config.ts";
import {
  encodeReleaseCalldata,
  rpc,
  toQuantity,
} from "./rhRpc.ts";

const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

function strip0x(hex: string): string {
  return hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
}

function hexToBytes(hex: string): Uint8Array {
  const h = strip0x(hex);
  if (h.length % 2 !== 0) throw new Error("odd hex length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < h.length; i += 2) out[i / 2] = parseInt(h.slice(i, i + 2), 16);
  return out;
}

function bytesToHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

function keccak(bytes: Uint8Array): Uint8Array {
  return keccak_256(bytes);
}

/** RLP encode a byte string or a list. */
export function rlpEncode(item: Uint8Array | Uint8Array[]): Uint8Array {
  if (item instanceof Uint8Array) return rlpBytes(item);
  const payload = concat(item.map(rlpEncode));
  return rlpLen(payload, 0xc0, 0xf7);
}

function rlpBytes(bytes: Uint8Array): Uint8Array {
  if (bytes.length === 1 && bytes[0] < 0x80) return bytes;
  return rlpLen(bytes, 0x80, 0xb7);
}

function rlpLen(payload: Uint8Array, shortOffset: number, longOffset: number): Uint8Array {
  if (payload.length <= 55) {
    return concat([Uint8Array.of(shortOffset + payload.length), payload]);
  }
  const lenBytes = bigIntToBytes(BigInt(payload.length));
  return concat([Uint8Array.of(longOffset + lenBytes.length), lenBytes, payload]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function bigIntToBytes(n: bigint): Uint8Array {
  if (n === 0n) return new Uint8Array();
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes(hex);
}

export function readReleaserKey(): string {
  const raw = (process.env.RH_RELEASER_KEY ?? process.env.RELEASER_KEY ?? "").trim();
  if (!raw) throw new Error("RH_RELEASER_KEY is required for live release");
  const hex = strip0x(raw);
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("RH_RELEASER_KEY must be a 32-byte hex private key");
  }
  return hex.toLowerCase();
}

export function addressFromPrivateKey(keyHex: string): string {
  const priv = hexToBytes(keyHex);
  const pub = secp256k1.getPublicKey(priv, false); // 65 bytes, 0x04||x||y
  const hash = keccak(pub.slice(1));
  return "0x" + Buffer.from(hash.slice(-20)).toString("hex");
}

export function releaserAddressFromEnv(): string | null {
  const explicit = (process.env.RH_RELEASER_ADDRESS ?? "").trim();
  if (explicit) return explicit.toLowerCase();
  try {
    return addressFromPrivateKey(readReleaserKey());
  } catch {
    return null;
  }
}

type LegacyTx = {
  nonce: bigint;
  gasPrice: bigint;
  gas: bigint;
  to: string;
  value: bigint;
  data: Uint8Array;
  chainId: number;
};

function txList(tx: LegacyTx, sig?: { v: bigint; r: Uint8Array; s: Uint8Array }): Uint8Array[] {
  const to = hexToBytes(tx.to);
  const items: Uint8Array[] = [
    bigIntToBytes(tx.nonce),
    bigIntToBytes(tx.gasPrice),
    bigIntToBytes(tx.gas),
    to,
    bigIntToBytes(tx.value),
    tx.data,
  ];
  if (!sig) {
    items.push(bigIntToBytes(BigInt(tx.chainId)), new Uint8Array(), new Uint8Array());
    return items;
  }
  items.push(bigIntToBytes(sig.v), trimLeft(sig.r), trimLeft(sig.s));
  return items;
}

function trimLeft(bytes: Uint8Array): Uint8Array {
  let i = 0;
  while (i < bytes.length - 1 && bytes[i] === 0) i++;
  return bytes.slice(i);
}

export function signLegacyTx(tx: LegacyTx, keyHex: string): string {
  const unsigned = rlpEncode(txList(tx));
  const msgHash = keccak(unsigned);
  const priv = hexToBytes(keyHex);
  const sig = secp256k1.sign(msgHash, priv);
  const r = hexToBytes(sig.r.toString(16).padStart(64, "0"));
  const s = hexToBytes(sig.s.toString(16).padStart(64, "0"));
  const recovery = sig.recovery;
  const v = BigInt(tx.chainId) * 2n + 35n + BigInt(recovery);
  const raw = rlpEncode(txList(tx, { v, r, s }));
  return bytesToHex(raw);
}

export async function sendRelease(opts: {
  rpcUrl: string;
  vault: string;
  depositId: bigint;
  to: string;
  chainId?: number;
  gasLimit?: bigint;
}): Promise<{ txHash: string; from: string }> {
  const to = opts.to.trim().toLowerCase();
  if (!/^0x[0-9a-f]{40}$/.test(to) || to === ZERO_ADDR) {
    throw new Error(`invalid release destination ${opts.to}`);
  }
  const key = readReleaserKey();
  const from = addressFromPrivateKey(key);
  const chainId = opts.chainId ?? RH_CHAIN_ID;
  const dataHex = encodeReleaseCalldata(opts.depositId, to);
  const nonceHex = await rpc<string>(opts.rpcUrl, "eth_getTransactionCount", [from, "pending"]);
  const gasPriceHex = await rpc<string>(opts.rpcUrl, "eth_gasPrice", []);
  const nonce = BigInt(nonceHex);
  const gasPrice = BigInt(gasPriceHex);
  const gas = opts.gasLimit ?? 200000n;
  const raw = signLegacyTx(
    {
      nonce,
      gasPrice,
      gas,
      to: opts.vault,
      value: 0n,
      data: hexToBytes(dataHex),
      chainId,
    },
    key,
  );
  const txHash = await rpc<string>(opts.rpcUrl, "eth_sendRawTransaction", [raw]);
  return { txHash, from };
}

export { toQuantity };
