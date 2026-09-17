/**
 * Prove a DepositLocked log actually happened before minting against it.
 *
 * The watcher used to take `eth_getLogs` at face value. It checked `topics[0]`
 * but never checked that the log came from the vault — it relied entirely on
 * the RPC honouring the `address` filter — and never confirmed the transaction
 * succeeded. With one hardcoded public endpoint, no fallback and no
 * cross-check, a hostile, hijacked or MITM'd RPC could return fabricated
 * DepositLocked logs and the keeper would mint unbacked wrappers against them.
 *
 * Two independent layers here:
 *
 *   1. Receipt check — re-fetch the transaction receipt and require that the
 *      transaction succeeded and that the exact log (same block, same
 *      logIndex, same emitter, same topics, same data) is really in it. This
 *      catches a filter the node ignored, a log from the wrong contract, and a
 *      log from a reverted transaction.
 *
 *   2. Independent confirmation — repeat the receipt check against other
 *      endpoints listed in RH_RPC_VERIFY. This is what actually defends against
 *      the primary RPC itself lying, since layer 1 alone asks the liar to mark
 *      its own homework.
 *
 * Outcomes separate "this is false" from "I could not tell": a mismatch is
 * fatal and must never mint, while an unreachable node or a receipt that has
 * not propagated yet is retryable.
 */
import { rpc } from "./rhRpc.ts";

export type ReceiptLog = {
  address: string;
  topics: string[];
  data: string;
  logIndex: string;
};

export type Receipt = {
  status?: string;
  blockNumber?: string;
  logs?: ReceiptLog[];
};

/** The parts of a candidate log that must match chain state exactly. */
export type DepositClaim = {
  txHash: string;
  blockNumber: number;
  logIndex: number;
  topics: string[];
  data: string;
};

export type SourceResult =
  | { source: string; ok: true }
  | { source: string; ok: false; fatal: boolean; reason: string };

export type VerifyOutcome = {
  ok: boolean;
  /** True when some source proved the claim false — never mint, never retry. */
  fatal: boolean;
  confirmedBy: string[];
  results: SourceResult[];
  reason?: string;
};

function norm(hex: string | undefined): string {
  return String(hex ?? "").trim().toLowerCase();
}

function sameTopics(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (norm(a[i]) !== norm(b[i])) return false;
  return true;
}

export async function getTransactionReceipt(
  rpcUrl: string,
  txHash: string,
): Promise<Receipt | null> {
  return rpc<Receipt | null>(rpcUrl, "eth_getTransactionReceipt", [txHash]);
}

/** Check one endpoint. Pure aside from the RPC call, so it is unit-testable. */
export function checkReceipt(
  receipt: Receipt | null,
  vault: string,
  claim: DepositClaim,
): { ok: boolean; fatal: boolean; reason?: string } {
  if (!receipt) {
    // Not necessarily a lie: could be an unsynced node or a receipt that has
    // not propagated. Retry rather than condemn.
    return { ok: false, fatal: false, reason: "receipt not found" };
  }
  if (norm(receipt.status) !== "0x1") {
    return { ok: false, fatal: true, reason: `transaction did not succeed (status ${receipt.status})` };
  }
  const rcptBlock = receipt.blockNumber ? Number(BigInt(receipt.blockNumber)) : null;
  if (rcptBlock === null) {
    return { ok: false, fatal: false, reason: "receipt has no blockNumber" };
  }
  if (rcptBlock !== claim.blockNumber) {
    return {
      ok: false,
      fatal: true,
      reason: `block mismatch: log claimed ${claim.blockNumber}, receipt says ${rcptBlock}`,
    };
  }
  const logs = receipt.logs ?? [];
  const match = logs.find((l) => Number(BigInt(l.logIndex ?? "0x0")) === claim.logIndex);
  if (!match) {
    return { ok: false, fatal: true, reason: `no log at logIndex ${claim.logIndex} in receipt` };
  }
  if (norm(match.address) !== norm(vault)) {
    return {
      ok: false,
      fatal: true,
      reason: `log emitter ${norm(match.address)} is not the vault ${norm(vault)}`,
    };
  }
  if (!sameTopics(match.topics ?? [], claim.topics)) {
    return { ok: false, fatal: true, reason: "topics do not match the receipt" };
  }
  if (norm(match.data) !== norm(claim.data)) {
    return { ok: false, fatal: true, reason: "data does not match the receipt" };
  }
  return { ok: true, fatal: false };
}

async function checkSource(
  rpcUrl: string,
  vault: string,
  claim: DepositClaim,
): Promise<SourceResult> {
  let receipt: Receipt | null;
  try {
    receipt = await getTransactionReceipt(rpcUrl, claim.txHash);
  } catch (e) {
    return {
      source: rpcUrl,
      ok: false,
      fatal: false,
      reason: `rpc error: ${e instanceof Error ? e.message : String(e)}`,
    };
  }
  const r = checkReceipt(receipt, vault, claim);
  return r.ok
    ? { source: rpcUrl, ok: true }
    : { source: rpcUrl, ok: false, fatal: r.fatal, reason: r.reason ?? "unknown" };
}

export type VerifyConfig = {
  /** Endpoint the log came from. Always checked. */
  primaryRpc: string;
  /** Independent endpoints; the only defence against the primary lying. */
  verifyRpcs?: string[];
  /** How many of `verifyRpcs` must confirm. Default: all of them. */
  quorum?: number;
};

/**
 * Verify a claimed DepositLocked against chain state.
 *
 * Any source proving the claim false makes the whole outcome fatal, even if
 * others confirm — a disagreement between endpoints means at least one is
 * wrong, which is exactly when minting must stop.
 */
export async function verifyDeposit(
  cfg: VerifyConfig,
  vault: string,
  claim: DepositClaim,
): Promise<VerifyOutcome> {
  const verifyRpcs = (cfg.verifyRpcs ?? []).filter((u) => u && u !== cfg.primaryRpc);
  const sources = [cfg.primaryRpc, ...verifyRpcs];
  const results = await Promise.all(sources.map((u) => checkSource(u, vault, claim)));

  const fatal = results.find((r) => !r.ok && r.fatal);
  const confirmedBy = results.filter((r) => r.ok).map((r) => r.source);

  if (fatal) {
    return {
      ok: false,
      fatal: true,
      confirmedBy,
      results,
      reason: `${fatal.source}: ${"reason" in fatal ? fatal.reason : "mismatch"}`,
    };
  }

  const primaryOk = results[0].ok;
  if (!primaryOk) {
    return {
      ok: false,
      fatal: false,
      confirmedBy,
      results,
      reason: `primary ${results[0].source}: ${"reason" in results[0] ? results[0].reason : "unavailable"}`,
    };
  }

  const needed = Math.min(
    cfg.quorum ?? verifyRpcs.length,
    verifyRpcs.length,
  );
  const independent = confirmedBy.filter((s) => s !== cfg.primaryRpc).length;
  if (independent < needed) {
    return {
      ok: false,
      fatal: false,
      confirmedBy,
      results,
      reason: `only ${independent}/${needed} independent confirmations`,
    };
  }

  return { ok: true, fatal: false, confirmedBy, results };
}

/** Parse RH_RPC_VERIFY — comma or whitespace separated endpoint list. */
export function parseVerifyRpcs(raw: string | undefined): string[] {
  return String(raw ?? "")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
