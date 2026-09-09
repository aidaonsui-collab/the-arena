/**
 * Decode stocks::bridge::RedeemBurned from Sui queryEvents parsedJson.
 * vector<u8> shows up as a number array, 0x-hex, utf8, or base64 (e.g. "QU1D" = "AMC").
 */
import { stockOf, type Ticker } from "./config.ts";

const TICKERS = new Set(["NVDA", "AMC", "GME", "TSLA"]);

export type RedeemBurn = {
  key: string;
  digest: string;
  eventSeq: string;
  ticker: Ticker;
  coinType: string;
  amount: bigint;
  burner: string;
  rhDest: string;
  timestampMs?: string;
};

export function parseVecU8(value: unknown): Uint8Array {
  if (value == null) return new Uint8Array();
  if (Array.isArray(value)) {
    return Uint8Array.from(value.map((n) => Number(n) & 0xff));
  }
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return new Uint8Array();
    if (/^0x[0-9a-fA-F]*$/.test(s) && s.length % 2 === 0) {
      const hex = s.slice(2);
      const out = new Uint8Array(hex.length / 2);
      for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.slice(i, i + 2), 16);
      return out;
    }
    if (/^[0-9a-fA-F]+$/.test(s) && s.length % 2 === 0 && s.length >= 8) {
      const out = new Uint8Array(s.length / 2);
      for (let i = 0; i < s.length; i += 2) out[i / 2] = parseInt(s.slice(i, i + 2), 16);
      return out;
    }
    const asUtf8 = Buffer.from(s, "utf8");
    if (TICKERS.has(asUtf8.toString("utf8").toUpperCase()) || asUtf8.length === 20) {
      return Uint8Array.from(asUtf8);
    }
    try {
      const b64 = Buffer.from(s, "base64");
      if (b64.length > 0 && b64.toString("base64").replace(/=+$/, "") === s.replace(/=+$/, "")) {
        return Uint8Array.from(b64);
      }
    } catch {
      /* fall through */
    }
    return Uint8Array.from(asUtf8);
  }
  if (typeof value === "object" && value !== null && "bytes" in value) {
    return parseVecU8((value as { bytes: unknown }).bytes);
  }
  return new Uint8Array();
}

export function vecToAscii(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8").replace(/\0+$/, "");
}

export function vecToHex(bytes: Uint8Array): string {
  return "0x" + Buffer.from(bytes).toString("hex");
}

export function normalizeEvmAddress(hex: string): string {
  const h = hex.trim().toLowerCase();
  const body = h.startsWith("0x") ? h.slice(2) : h;
  if (!/^[0-9a-f]{40}$/.test(body)) {
    throw new Error(`rh_dest must be a 20-byte EVM address, got ${hex}`);
  }
  return "0x" + body;
}

function coinTypeName(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const o = value as { name?: unknown };
    if (typeof o.name === "string") return o.name;
  }
  return "";
}

export function parseRedeemBurned(ev: {
  id: { txDigest: string; eventSeq: string };
  parsedJson?: unknown;
  timestampMs?: string;
}): RedeemBurn | null {
  const pj = (ev.parsedJson || {}) as {
    ticker?: unknown;
    amount?: unknown;
    burner?: unknown;
    rh_dest?: unknown;
    coin_type?: unknown;
  };
  const tickerBytes = parseVecU8(pj.ticker);
  const tickerRaw = vecToAscii(tickerBytes).toUpperCase();
  if (!TICKERS.has(tickerRaw)) return null;
  const ticker = tickerRaw as Ticker;
  stockOf(ticker);

  let amount: bigint;
  try {
    amount = BigInt(String(pj.amount ?? "0"));
  } catch {
    return null;
  }
  if (amount <= 0n) return null;

  const destBytes = parseVecU8(pj.rh_dest);
  if (destBytes.length !== 20) return null;
  let rhDest: string;
  try {
    rhDest = normalizeEvmAddress(vecToHex(destBytes));
  } catch {
    return null;
  }
  if (rhDest === "0x0000000000000000000000000000000000000000") return null;

  const burner = String(pj.burner ?? "");
  const digest = ev.id.txDigest;
  const eventSeq = String(ev.id.eventSeq);
  return {
    key: `${digest}:${eventSeq}`,
    digest,
    eventSeq,
    ticker,
    coinType: coinTypeName(pj.coin_type),
    amount,
    burner,
    rhDest,
    timestampMs: ev.timestampMs,
  };
}
