/**
 * Permissionless `config::ring_pit` once Clock >= round_end_ms.
 * Takes the Pit, Config and Clock; the round length comes from Config, not the
 * caller. The old `pit::ring` took `round_ms` as an argument and is retired.
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
    targets: { pitSui, pitXaum, fn: `${packageId}::config::ring_pit` },
  };
}
