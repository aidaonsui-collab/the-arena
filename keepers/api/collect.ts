import type { IncomingMessage, ServerResponse } from "node:http";
import { cronAuthorized, deny } from "../src/cronAuth.ts";
import { runCollectInstadex } from "../src/jobs/collectInstadex.ts";
import { runWithdrawPlatform } from "../src/jobs/withdrawPlatform.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cronAuthorized(req)) return deny(res);
  const collect = await runCollectInstadex();
  const withdraw = await runWithdrawPlatform();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ collect, withdraw }));
}
