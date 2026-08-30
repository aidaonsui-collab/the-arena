import { runIndexReflections } from "./jobs/indexReflections.ts";
import { runRingPit } from "./jobs/ringPit.ts";
import { runSettlePit } from "./jobs/settlePit.ts";
import { runCollectInstadex } from "./jobs/collectInstadex.ts";

const job = process.argv[2];

const jobs: Record<string, () => Promise<unknown>> = {
  reflections: runIndexReflections,
  ring: runRingPit,
  settle: runSettlePit,
  collect: runCollectInstadex,
};

if (!job || !jobs[job]) {
  console.error("usage: tsx src/cli.ts <reflections|ring|settle|collect>");
  process.exit(1);
}

const out = await jobs[job]();
console.log(JSON.stringify(out, null, 2));
