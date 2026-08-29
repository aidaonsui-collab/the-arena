/**
 * Permissionless `pit::ring` once Clock >= round_end_ms.
 * Needs a funded keeper key (ARENA_KEEPER_PHRASE) after the package is published.
 */
import { env } from "../config.ts";

export async function runRingPit() {
  const { packageId, pitSui, pitXaum } = env();
  if (!packageId) {
    return { skipped: true, reason: "ARENA_PACKAGE_ID unset" };
  }
  // Signed PTB lands once a keeper wallet is configured.
  return {
    skipped: true,
    reason: "ring PTB not signed yet",
    targets: { pitSui, pitXaum, fn: `${packageId}::pit::ring` },
  };
}
