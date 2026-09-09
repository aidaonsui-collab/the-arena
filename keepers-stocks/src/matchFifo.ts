/**
 * FIFO match of a Sui RedeemBurned amount against whole RH StockLockVault
 * deposits. release() is all-or-nothing per depositId, so a burn that does
 * not equal a prefix-sum of whole locks is flagged instead of over/under
 * releasing silently.
 *
 * Amounts: RH locks are 18dp; Sui wraps are 9dp (RH_TO_SUI_SCALE). A lock's
 * Sui-equivalent is floor(rhAmount / 1e9). Matching uses that; a live
 * release() still pays the full original RH amount (mint-side dust).
 */
import { RH_TO_SUI_SCALE } from "./config.ts";

export type RhLock = {
  depositId: bigint;
  token: string;
  amount: bigint;
  released: boolean;
};

export type ConsumedLock = {
  depositId: string;
  rhAmount: string;
  suiAmount: string;
  token: string;
};

export type MatchStatus = "exact" | "partial" | "unmatched";

export type MatchResult = {
  status: MatchStatus;
  consumed: ConsumedLock[];
  leftoverSui: string;
  mismatch: string | null;
  skippedDustIds: string[];
};

export function rhAmountToSui(rhAmount: bigint): bigint {
  if (rhAmount <= 0n) return 0n;
  return rhAmount / RH_TO_SUI_SCALE;
}

function asConsumed(lock: RhLock, suiAmount: bigint): ConsumedLock {
  return {
    depositId: lock.depositId.toString(),
    rhAmount: lock.amount.toString(),
    suiAmount: suiAmount.toString(),
    token: lock.token,
  };
}

/**
 * Consume oldest unreleased locks (by depositId) whose Sui-equivalent fits
 * in the remaining burn. Stop before a lock that would over-release.
 */
export function matchFifo(burnSui: bigint, locks: RhLock[]): MatchResult {
  const empty = (mismatch: string | null, leftover: bigint): MatchResult => ({
    status: "unmatched",
    consumed: [],
    leftoverSui: leftover.toString(),
    mismatch,
    skippedDustIds: [],
  });

  if (burnSui <= 0n) {
    return empty("burn amount must be > 0", 0n);
  }

  const eligible = locks
    .filter((l) => !l.released && l.amount > 0n)
    .slice()
    .sort((a, b) => (a.depositId < b.depositId ? -1 : a.depositId > b.depositId ? 1 : 0));

  const skippedDustIds: string[] = [];
  const consumed: ConsumedLock[] = [];
  let remaining = burnSui;

  for (const lock of eligible) {
    if (remaining === 0n) break;
    const sui = rhAmountToSui(lock.amount);
    if (sui === 0n) {
      skippedDustIds.push(lock.depositId.toString());
      continue;
    }
    if (sui <= remaining) {
      consumed.push(asConsumed(lock, sui));
      remaining -= sui;
      continue;
    }
    const mismatch =
      `next lock depositId=${lock.depositId.toString()} sui=${sui.toString()} ` +
      `exceeds leftover burn ${remaining.toString()}; release() is all-or-nothing, ` +
      `so this lock is not taken (would over-release)`;
    return {
      status: consumed.length ? "partial" : "unmatched",
      consumed,
      leftoverSui: remaining.toString(),
      mismatch,
      skippedDustIds,
    };
  }

  if (remaining === 0n && consumed.length > 0) {
    return { status: "exact", consumed, leftoverSui: "0", mismatch: null, skippedDustIds };
  }

  const mismatch = consumed.length
    ? `burn leftover ${remaining.toString()} after ${consumed.length} whole lock(s); no further unreleased lock fits`
    : `no unreleased locks whose Sui-equivalent can cover burn ${burnSui.toString()}`;
  return {
    status: consumed.length ? "partial" : "unmatched",
    consumed,
    leftoverSui: remaining.toString(),
    mismatch,
    skippedDustIds,
  };
}
