const job = process.argv[2];

const jobs: Record<string, () => Promise<unknown>> = {
  reflections: async () => (await import("./jobs/indexReflections.ts")).runIndexReflections(),
  trades: async () => (await import("./jobs/indexTrades.ts")).runIndexTrades(),
  pit: async () => (await import("./jobs/refreshPitState.ts")).runRefreshPitState(),
  ring: async () => (await import("./jobs/ringPit.ts")).runRingPit(),
  settle: async () => ({
    instadex: await (await import("./jobs/settleInstadex.ts")).runSettleInstadex(),
    curve: await (await import("./jobs/settlePit.ts")).runSettlePit(),
  }),
  instadex: async () => (await import("./jobs/settleInstadex.ts")).runSettleInstadex(),
  collect: async () => (await import("./jobs/collectInstadex.ts")).runCollectInstadex(),
  withdraw: async () => (await import("./jobs/withdrawPlatform.ts")).runWithdrawPlatform(),
  "convert-basket": async () => (await import("./jobs/convertBasketYield.ts")).runConvertBasketYield(),
  convertBasket: async () => (await import("./jobs/convertBasketYield.ts")).runConvertBasketYield(),
};

if (!job || !jobs[job]) {
  console.error(
    "usage: tsx src/cli.ts <reflections|trades|pit|ring|settle|instadex|collect|withdraw|convert-basket>",
  );
  process.exit(1);
}

const out = await jobs[job]();
console.log(JSON.stringify(out, null, 2));
