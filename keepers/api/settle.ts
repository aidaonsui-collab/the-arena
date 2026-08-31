import type { IncomingMessage, ServerResponse } from "node:http";
import { cronAuthorized, deny } from "../src/cronAuth.ts";
import { runSettleInstadex } from "../src/jobs/settleInstadex.ts";
import { runSettlePit } from "../src/jobs/settlePit.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cronAuthorized(req)) return deny(res);
  const instadex = await runSettleInstadex().catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  const curve = await runSettlePit().catch((e) => ({
    error: e instanceof Error ? e.message : String(e),
  }));
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ instadex, curve }));
}
