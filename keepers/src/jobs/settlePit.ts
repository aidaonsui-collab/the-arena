/**
 * After BellEvent, call `pool::settle_pit` on the winning pool.
 * Burn-mode winners that already locked LP forfeit (pot stays) so the next ring can run.
 */
import { Transaction } from "@mysten/sui/transactions";
import {
  CALL_PKG,
  PIT_SUI,
  PIT_XAUM,
  objectFields,
  parseOptionId,
  poolTypeArgs,
} from "../chain.ts";
import { loadSigner } from "../loadSigner.ts";
import { client } from "../sui.ts";

async function settleOne(pitId: string) {
  const pit = await objectFields(pitId);
  if (!pit) return { pitId, skipped: true, reason: "pit missing" };
  if (pit.fields.settled) return { pitId, skipped: true, reason: "already settled" };
  const winner = parseOptionId(pit.fields.winner_id);
  if (!winner) return { pitId, skipped: true, reason: "no winner" };

  const pool = await objectFields(winner);
  if (!pool) return { pitId, winner, skipped: true, reason: "winner pool missing" };
  const types = poolTypeArgs(pool.type);
  if (!types) return { pitId, winner, skipped: true, reason: `bad pool type ${pool.type}` };

  const kp = loadSigner();
  const tx = new Transaction();
  tx.moveCall({
    target: `${CALL_PKG}::pool::settle_pit`,
    typeArguments: types,
    arguments: [tx.object(winner), tx.object(pitId)],
  });
  const sent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true },
  });
  return {
    pitId,
    winner,
    digest: sent.digest,
    status: sent.effects?.status?.status,
    types,
  };
}

export async function runSettlePit() {
  const results = [];
  for (const id of [PIT_SUI, PIT_XAUM]) {
    try {
      results.push(await settleOne(id));
    } catch (e) {
      results.push({ pitId: id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { callPackage: CALL_PKG, results };
}
