/**
 * Permissionless `pit::ring` once Clock >= round_end_ms and the previous winner is settled.
 */
import { Transaction } from "@mysten/sui/transactions";
import { CALL_PKG, CLOCK, CONFIG, PIT_SUI, PIT_XAUM, SUI, XAUM, objectFields } from "../chain.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";

async function ringOne(pitId: string, quote: string, roundMs: string) {
  const pit = await objectFields(pitId);
  if (!pit) return { pitId, skipped: true, reason: "pit missing" };
  const end = Number(pit.fields.round_end_ms || 0);
  if (!end) return { pitId, skipped: true, reason: "round not started" };
  if (Date.now() < end) return { pitId, skipped: true, reason: "too early", roundEndMs: end };
  if (!pit.fields.settled) return { pitId, skipped: true, reason: "unsettled winner" };

  const kp = loadSigner();
  const tx = new Transaction();
  tx.moveCall({
    target: `${CALL_PKG}::pit::ring`,
    typeArguments: [quote],
    arguments: [tx.object(pitId), tx.pure.u64(BigInt(roundMs)), tx.object(CLOCK)],
  });
  const sent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
  });
  return { pitId, digest: sent.digest, status: sent.effects?.status?.status };
}

export async function runRingPit() {
  const cfg = await objectFields(CONFIG);
  if (!cfg) return { skipped: true, reason: "config missing" };
  const roundMs = String(cfg.fields.round_ms || "86400000");
  const results = [];
  for (const [id, quote] of [
    [PIT_SUI, SUI],
    [PIT_XAUM, XAUM],
  ] as const) {
    try {
      results.push(await ringOne(id, quote, roundMs));
    } catch (e) {
      results.push({ pitId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { callPackage: CALL_PKG, roundMs, results };
}
