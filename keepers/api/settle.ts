import type { IncomingMessage, ServerResponse } from "node:http";
import { cronAuthorized, deny } from "../src/cronAuth.ts";
import { runSettlePit } from "../src/jobs/settlePit.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cronAuthorized(req)) return deny(res);
  const out = await runSettlePit();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}
