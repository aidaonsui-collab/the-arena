/**
 * After BellEvent, call `pool::settle_pit` on the winning pool.
 * Holders mode: pot becomes claimable. Burn mode: curve buy + burn.
 */
import { env } from "../config.ts";

export async function runSettlePit() {
  const { packageId } = env();
  if (!packageId) {
    return { skipped: true, reason: "ARENA_PACKAGE_ID unset" };
  }
  return {
    skipped: true,
    reason: "settle PTB not signed yet",
    fn: `${packageId}::pool::settle_pit`,
  };
}
