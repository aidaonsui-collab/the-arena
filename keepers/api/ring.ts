import type { IncomingMessage, ServerResponse } from "node:http";
import { runRingPit } from "../src/jobs/ringPit.ts";

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  const out = await runRingPit();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}
