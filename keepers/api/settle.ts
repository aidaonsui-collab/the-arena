import type { IncomingMessage, ServerResponse } from "node:http";
import { runSettlePit } from "../src/jobs/settlePit.ts";

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  const out = await runSettlePit();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}
