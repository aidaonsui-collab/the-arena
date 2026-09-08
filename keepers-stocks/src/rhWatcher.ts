/**
 * Stub RH vault watcher.
 *
 * v1: RH vault is OFF-CHAIN — we do not deploy Solidity here.
 * This process polls nothing until RH_VAULT_ADDRESS + RH_RPC are set.
 *
 * TODO once vault exists:
 *  1. Poll RH RPC for Transfer/Lock events into the vault for known stock tokens
 *     (NVDA 0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC, …).
 *  2. Map lock → { ticker, amount (18dec), recipient Sui address, rh_tx_hash }.
 *  3. Call attestAndMint (or enqueue for operator CLI).
 *  4. Also watch Sui RedeemBurned → release RH vault.
 */
import { STOCKS } from "./config.ts";

export type RhWatcherConfig = {
  rhRpc?: string;
  vaultAddress?: string;
  pollMs?: number;
};

export async function runRhWatcher(cfg: RhWatcherConfig = {}) {
  const rhRpc = cfg.rhRpc ?? process.env.RH_RPC ?? "";
  const vault = cfg.vaultAddress ?? process.env.RH_VAULT_ADDRESS ?? "";
  const pollMs = cfg.pollMs ?? Number(process.env.RH_WATCH_POLL_MS || 15_000);

  console.log(
    JSON.stringify(
      {
        status: "stub",
        message:
          "RH watcher is a stub. No RPC polls until RH_VAULT_ADDRESS and RH_RPC are configured.",
        rhRpc: rhRpc || null,
        vaultAddress: vault || null,
        pollMs,
        knownRhTokens: Object.values(STOCKS).map((s) => ({
          ticker: s.ticker,
          rhToken: s.rhToken || null,
        })),
        todos: [
          "Deploy or designate RH-side vault that locks stock ERC-20s",
          "Set RH_RPC (Robinhood Chain JSON-RPC) and RH_VAULT_ADDRESS",
          "Index Lock/Deposit logs → call keepers-stocks mint with rh_tx_hash",
          "Index stocks::bridge::RedeemBurned → unlock RH vault 1:1",
        ],
      },
      null,
      2,
    ),
  );

  if (!rhRpc || !vault) {
    return {
      ok: true,
      stub: true,
      reason: "missing RH_RPC or RH_VAULT_ADDRESS — idle",
    };
  }

  console.error(
    `[rh-watcher] TODO: poll ${rhRpc} vault ${vault} every ${pollMs}ms — not implemented`,
  );
  return {
    ok: true,
    stub: true,
    reason: "RH_RPC/vault set but poller not implemented yet",
  };
}
