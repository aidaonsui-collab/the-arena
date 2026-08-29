import type { IncomingMessage, ServerResponse } from "node:http";
import { runIndexReflections } from "../src/jobs/indexReflections.ts";

export default async function handler(_req: IncomingMessage, res: ServerResponse) {
  const out = await runIndexReflections();
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(out));
}
