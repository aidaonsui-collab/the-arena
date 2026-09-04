import { runIndexReflections } from "./jobs/indexReflections.ts";
import { runIndexTrades } from "./jobs/indexTrades.ts";
import { runRefreshPitState } from "./jobs/refreshPitState.ts";
import { runRefreshPerpTokens } from "./jobs/refreshPerpTokens.ts";
import { runRingPit } from "./jobs/ringPit.ts";
import { runSettleInstadex } from "./jobs/settleInstadex.ts";
import { runSettlePit } from "./jobs/settlePit.ts";
import { runCollectInstadex } from "./jobs/collectInstadex.ts";
import { runWithdrawPlatform } from "./jobs/withdrawPlatform.ts";

const job = process.argv[2];

const jobs: Record<string, () => Promise<unknown>> = {
  reflections: runIndexReflections,
  trades: runIndexTrades,
  pit: runRefreshPitState,
  perp: runRefreshPerpTokens,
  ring: runRingPit,
  settle: async () => ({
    instadex: await runSettleInstadex(),
    curve: await runSettlePit(),
  }),
  instadex: runSettleInstadex,
  collect: runCollectInstadex,
  withdraw: runWithdrawPlatform,
};

if (!job || !jobs[job]) {
  console.error("usage: tsx src/cli.ts <reflections|trades|pit|perp|ring|settle|instadex|collect|withdraw>");
  process.exit(1);
}

const out = await jobs[job]();
console.log(JSON.stringify(out, null, 2));
