import type { IncomingMessage, ServerResponse } from "node:http";
import { cronAuthorized, deny } from "../src/cronAuth.ts";
import { runConvertBasketYield } from "../src/jobs/convertBasketYield.ts";

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  if (!cronAuthorized(req)) return deny(res);
  try {
    const out = await runConvertBasketYield();
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(out));
  } catch (e) {
    res.statusCode = 500;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }));
  }
}
