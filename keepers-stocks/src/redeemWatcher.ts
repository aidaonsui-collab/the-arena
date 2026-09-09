/**
 * Sui RedeemBurned → RH StockLockVault.release watcher.
 *
 * Polls stocks::bridge::RedeemBurned (ascending), FIFO-matches each burn
 * against unreleased RH locks of that ticker, and either logs a release plan
 * (default) or broadcasts release(depositId, rh_dest) when live mode is
 * explicitly enabled.
 *
 * Env:
 *   RH_RPC / RH_VAULT_ADDRESS     same defaults as watch-rh
 *   RH_REDEEM_POLL_MS             default 15000
 *   RH_REDEEM_LOOP=1              continuous; otherwise one pass and exit
 *   STOCKS_RELEASE_LIVE=1         actually send release() (also CLI --live)
 *   RH_RELEASER_KEY               32-byte hex; never logged
 *   RH_RELEASER_ADDRESS           eth_call `from` / sanity check (optional)
 *   STOCKS_DATA_DIR               redeemed.json (default ./data)
 *
 * Default is dry-run. Live requires --live or STOCKS_RELEASE_LIVE=1 AND a key.
 * A mismatch (burn amount ≠ FIFO prefix of whole deposits) is flagged and
 * never silently over-released.
 */
import {
  DEFAULT_RH_RPC,
  DEFAULT_RH_VAULT_ADDRESS,
  DEFAULT_RH_RELEASER_ADDRESS,
  STOCKS,
  env,
  redeemEventType,
  releaseLiveRequested,
  stockOf,
  type Ticker,
} from "./config.ts";
import { releaserAddressFromEnv, sendRelease } from "./evmRelease.ts";
import { matchFifo, type RhLock } from "./matchFifo.ts";
import { parseRedeemBurned, type RedeemBurn } from "./redeemEvent.ts";
import {
  alreadyHandled,
  currentCursor,
  isDepositClaimed,
  isDepositReleased,
  loadRedeemStore,
  pendingDepositIds,
  recordBurn,
  saveCursor,
  type BurnRecord,
  type ReleaseAttempt,
} from "./redeemStore.ts";
import { listLocks, simulateRelease, type VaultLock } from "./rhRpc.ts";
import { queryEvents, type EventCursor } from "./sui.ts";

export type RedeemWatcherConfig = {
  rhRpc?: string;
  vaultAddress?: string;
  pollMs?: number;
  once?: boolean;
  live?: boolean;
};

export type BurnAttempt = {
  burn: RedeemBurn;
  ok: boolean;
  skipped?: string;
  record?: BurnRecord;
  error?: string;
};

function tickerToken(ticker: Ticker): string {
  return stockOf(ticker).rhToken.trim().toLowerCase();
}

function toRhLock(lock: VaultLock): RhLock {
  return {
    depositId: lock.depositId,
    token: lock.token.toLowerCase(),
    amount: lock.amount,
    released: lock.released,
  };
}

async function fetchNewBurns(cursor: EventCursor | null): Promise<{
  burns: RedeemBurn[];
  nextCursor: EventCursor | null;
}> {
  const type = redeemEventType();
  const burns: RedeemBurn[] = [];
  let next: EventCursor | null = cursor;
  for (let page = 0; page < 40; page++) {
    const res = await queryEvents(type, next, 50, "ascending");
    for (const ev of res.data) {
      const parsed = parseRedeemBurned({
        id: ev.id,
        parsedJson: ev.parsedJson,
        timestampMs: ev.timestampMs ?? undefined,
      });
      if (parsed) burns.push(parsed);
    }
    if (res.nextCursor) {
      next = res.nextCursor as EventCursor;
    }
    if (!res.hasNextPage || !res.nextCursor) break;
  }
  return { burns, nextCursor: next };
}

async function broadcastPending(
  rec: BurnRecord,
  opts: { rhRpc: string; vault: string },
): Promise<BurnRecord> {
  const pending = new Set(pendingDepositIds(rec));
  for (const attempt of rec.releases) {
    if (!pending.has(attempt.depositId)) continue;
    if (attempt.simulatedOk === false) {
      attempt.error = `eth_call reverted: ${attempt.simulateError}`;
      console.error(
        JSON.stringify({
          event: "releaseSkip",
          flag: "MISMATCH",
          depositId: attempt.depositId,
          error: attempt.error,
        }),
      );
      continue;
    }
    try {
      const sent = await sendRelease({
        rpcUrl: opts.rhRpc,
        vault: opts.vault,
        depositId: BigInt(attempt.depositId),
        to: attempt.to,
      });
      attempt.txHash = sent.txHash;
      if (!rec.releasedDepositIds.includes(attempt.depositId)) {
        rec.releasedDepositIds.push(attempt.depositId);
      }
      console.log(
        JSON.stringify({
          event: "release",
          depositId: attempt.depositId,
          to: attempt.to,
          txHash: sent.txHash,
          from: sent.from,
        }),
      );
    } catch (e) {
      attempt.error = e instanceof Error ? e.message : String(e);
      console.error(
        JSON.stringify({
          event: "releaseError",
          depositId: attempt.depositId,
          error: attempt.error,
        }),
      );
    }
  }
  rec.dryRun = false;
  rec.at = new Date().toISOString();
  if (rec.releasedDepositIds.length !== rec.consumedDepositIds.length) {
    rec.mismatch =
      (rec.mismatch ? rec.mismatch + "; " : "") +
      `released ${rec.releasedDepositIds.length}/${rec.consumedDepositIds.length} ` +
      `consumed locks; remaining will retry on next pass`;
    rec.status = rec.releasedDepositIds.length ? "partial" : "error";
  }
  recordBurn(rec);
  return rec;
}

export async function handleBurn(
  burn: RedeemBurn,
  locks: VaultLock[],
  opts: {
    live: boolean;
    rhRpc: string;
    vault: string;
    simulateFrom: string;
    claimed: Set<string>;
  },
): Promise<BurnAttempt> {
  if (alreadyHandled(burn.key, opts.live)) {
    return { burn, ok: true, skipped: "already handled" };
  }

  const existing = loadRedeemStore().burns[burn.key];
  if (existing && !existing.dryRun && pendingDepositIds(existing).length > 0 && opts.live) {
    for (const id of pendingDepositIds(existing)) opts.claimed.add(id);
    const rec = await broadcastPending({ ...existing, releases: existing.releases.map((r) => ({ ...r })) }, opts);
    const allSent = rec.consumedDepositIds.every((id) => rec.releasedDepositIds.includes(id));
    return { burn, ok: allSent, record: rec, error: allSent ? undefined : rec.mismatch ?? undefined };
  }

  const token = tickerToken(burn.ticker);
  const available = locks
    .filter((l) => l.token.toLowerCase() === token)
    .filter((l) => !l.released)
    .filter((l) => !isDepositClaimed(l.depositId.toString(), burn.key))
    .filter((l) => !opts.claimed.has(l.depositId.toString()))
    .map(toRhLock);

  const match = matchFifo(burn.amount, available);
  const at = new Date().toISOString();

  const releases: ReleaseAttempt[] = [];
  for (const c of match.consumed) {
    const sim = await simulateRelease(
      opts.rhRpc,
      opts.vault,
      opts.simulateFrom,
      BigInt(c.depositId),
      burn.rhDest,
    );
    releases.push({
      depositId: c.depositId,
      to: burn.rhDest,
      token: c.token,
      rhAmount: c.rhAmount,
      suiAmount: c.suiAmount,
      simulatedOk: sim.ok,
      simulateError: sim.error,
    });
  }

  const plan = {
    event: "RedeemBurned",
    flag: match.mismatch ? "MISMATCH" : "PLAN",
    mode: opts.live ? "live" : "dry-run",
    key: burn.key,
    digest: burn.digest,
    ticker: burn.ticker,
    amountSui: burn.amount.toString(),
    burner: burn.burner,
    rhDest: burn.rhDest,
    match: {
      status: match.status,
      leftoverSui: match.leftoverSui,
      mismatch: match.mismatch,
      skippedDustIds: match.skippedDustIds,
      consumed: match.consumed,
    },
    wouldRelease: releases.map((r) => ({
      depositId: r.depositId,
      to: r.to,
      token: r.token,
      rhAmount: r.rhAmount,
      simulatedOk: r.simulatedOk,
      simulateError: r.simulateError ?? null,
    })),
  };
  if (match.mismatch) console.error(JSON.stringify(plan));
  else console.log(JSON.stringify(plan));

  for (const c of match.consumed) opts.claimed.add(c.depositId);

  const rec: BurnRecord = {
    key: burn.key,
    digest: burn.digest,
    eventSeq: burn.eventSeq,
    ticker: burn.ticker,
    amount: burn.amount.toString(),
    burner: burn.burner,
    rhDest: burn.rhDest,
    status: match.status,
    leftoverSui: match.leftoverSui,
    mismatch: match.mismatch,
    consumedDepositIds: match.consumed.map((c) => c.depositId),
    releasedDepositIds: [],
    releases,
    dryRun: !opts.live,
    at,
  };

  if (!opts.live) {
    recordBurn(rec);
    return { burn, ok: true, record: rec };
  }

  if (match.consumed.length === 0) {
    rec.dryRun = false;
    recordBurn(rec);
    return { burn, ok: false, skipped: match.mismatch ?? "nothing to release", record: rec };
  }

  const sent = await broadcastPending(rec, opts);
  const allSent = sent.consumedDepositIds.every((id) => sent.releasedDepositIds.includes(id));
  return { burn, ok: allSent, record: sent, error: allSent ? undefined : sent.mismatch ?? undefined };
}

export async function runRedeemWatcher(cfg: RedeemWatcherConfig = {}) {
  const rhRpc = cfg.rhRpc ?? process.env.RH_RPC ?? DEFAULT_RH_RPC;
  const vault = (cfg.vaultAddress ?? process.env.RH_VAULT_ADDRESS ?? DEFAULT_RH_VAULT_ADDRESS).trim();
  const pollMs = cfg.pollMs ?? Number(process.env.RH_REDEEM_POLL_MS || process.env.RH_WATCH_POLL_MS || 15_000);
  const loop = process.env.RH_REDEEM_LOOP === "1" && cfg.once !== true;
  const live = releaseLiveRequested(cfg.live === true);
  const { packageId, dataDir } = env();
  const simulateFrom = (
    releaserAddressFromEnv() ??
    process.env.RH_RELEASER_ADDRESS ??
    DEFAULT_RH_RELEASER_ADDRESS
  ).trim();

  if (live) {
    try {
      const { readReleaserKey, addressFromPrivateKey } = await import("./evmRelease.ts");
      const addr = addressFromPrivateKey(readReleaserKey());
      if (simulateFrom && addr.toLowerCase() !== simulateFrom.toLowerCase()) {
        console.error(
          JSON.stringify({
            flag: "WARN",
            msg: "RH_RELEASER_ADDRESS does not match key-derived address",
            derived: addr,
            configured: simulateFrom,
          }),
        );
      }
    } catch (e) {
      return {
        ok: false,
        live: true,
        error: e instanceof Error ? e.message : String(e),
        note: "live mode refused: no key loaded; nothing was broadcast",
      };
    }
  }

  console.log(
    JSON.stringify(
      {
        status: vault ? "watching" : "idle",
        mode: live ? "live" : "dry-run",
        rhRpc,
        vaultAddress: vault || null,
        packageId,
        redeemEvent: redeemEventType(),
        pollMs,
        loop,
        dataDir,
        simulateFrom,
        knownTickers: Object.values(STOCKS).map((s) => ({
          ticker: s.ticker,
          rhToken: s.rhToken,
          suiVault: s.vaultId,
        })),
        note: live
          ? "STOCKS_RELEASE_LIVE set — will broadcast release() for exact/partial FIFO matches"
          : "dry-run: logs the release plan and eth_call simulation; will not send. Set STOCKS_RELEASE_LIVE=1 or pass --live to broadcast.",
      },
      null,
      2,
    ),
  );

  if (!vault) {
    return { ok: true, stub: true, reason: "missing RH_VAULT_ADDRESS" };
  }

  const attempts: BurnAttempt[] = [];

  const pass = async () => {
    const locks = await listLocks(rhRpc, vault);
    const claimed = new Set(
      Object.keys(loadRedeemStore().releasedDepositIds).filter((id) => isDepositReleased(id)),
    );
    if (live) {
      for (const rec of Object.values(loadRedeemStore().burns)) {
        if (rec.dryRun || pendingDepositIds(rec).length === 0) continue;
        const burn: RedeemBurn = {
          key: rec.key,
          digest: rec.digest,
          eventSeq: rec.eventSeq,
          ticker: rec.ticker as Ticker,
          coinType: "",
          amount: BigInt(rec.amount),
          burner: rec.burner,
          rhDest: rec.rhDest,
        };
        attempts.push(
          await handleBurn(burn, locks, { live, rhRpc, vault, simulateFrom, claimed }),
        );
      }
    }
    const { burns, nextCursor } = await fetchNewBurns(currentCursor());
    for (const burn of burns) {
      const attempt = await handleBurn(burn, locks, {
        live,
        rhRpc,
        vault,
        simulateFrom,
        claimed,
      });
      attempts.push(attempt);
    }
    if (nextCursor) saveCursor(nextCursor);
    return { burns: burns.length, locks: locks.length, outstanding: locks.filter((l) => !l.released).length };
  };

  try {
    const stats = await pass();
    if (!loop) {
      return {
        ok: true,
        live,
        polled: true,
        ...stats,
        attempts,
      };
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[redeem-watcher] poll error: ${msg}`);
    if (!loop) {
      return { ok: false, live, error: msg, attempts };
    }
  }

  console.error(`[redeem-watcher] looping every ${pollMs}ms (mode=${live ? "live" : "dry-run"})`);
  for (;;) {
    await new Promise((r) => setTimeout(r, pollMs));
    try {
      await pass();
    } catch (e) {
      console.error(`[redeem-watcher] poll error: ${(e as Error).message}`);
    }
  }
}
