import type { IncomingMessage, ServerResponse } from "node:http";
import { runCollectInstadex } from "../src/jobs/collectInstadex.ts";

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  const out = await runCollectInstadex();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}
