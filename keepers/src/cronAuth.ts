import type { IncomingMessage, ServerResponse } from "node:http";

/** Vercel Cron sends `Authorization: Bearer $CRON_SECRET`. Deny on Vercel if unset. */
export function cronAuthorized(req: IncomingMessage): boolean {
  const secret = process.env.CRON_SECRET ?? "";
  if (!secret) return !process.env.VERCEL;
  const raw = req.headers.authorization;
  const header = Array.isArray(raw) ? raw[0] : raw;
  return header === `Bearer ${secret}`;
}

export function deny(res: ServerResponse) {
  res.statusCode = 401;
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ error: "unauthorized" }));
}
