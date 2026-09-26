const job = process.argv[2];

const jobs: Record<string, () => Promise<unknown>> = {
  reflections: async () => (await import("./jobs/indexReflections.ts")).runIndexReflections(),
  trades: async () => (await import("./jobs/indexTrades.ts")).runIndexTrades(),
  hop: async () => (await import("./jobs/publishHop.ts")).runPublishHop(),
  "index-rewards": async () => (await import("./jobs/indexRewards.ts")).runIndexRewards(),
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
  "push-yield": async () => (await import("./jobs/pushHolderYield.ts")).runPushHolderYield(),
  pushYield: async () => (await import("./jobs/pushHolderYield.ts")).runPushHolderYield(),
  "burn-vice": async () => (await import("./jobs/buybackBurnVice.ts")).runBuybackBurnVice(),
  burnVice: async () => (await import("./jobs/buybackBurnVice.ts")).runBuybackBurnVice(),
  "push-basket": async () => (await import("./jobs/pushBasketYield.ts")).runPushBasketYield(),
  pushBasket: async () => (await import("./jobs/pushBasketYield.ts")).runPushBasketYield(),
};

if (!job || !jobs[job]) {
  console.error(
    "usage: tsx src/cli.ts <reflections|trades|hop|index-rewards|pit|ring|settle|instadex|collect|withdraw|convert-basket|push-yield|burn-vice|push-basket>",
  );
  process.exit(1);
}

const out = await jobs[job]();
console.log(JSON.stringify(out, null, 2));
