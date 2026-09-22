export function keeperAuthOk(request) {
  const raw = request.headers.get("authorization") || "";
  const token = raw.replace(/^Bearer\s+/i, "").trim();
  const secrets = [process.env.CRON_SECRET, process.env.ARENA_SETTLE_SECRET].filter(Boolean);
  if (!secrets.length) return !process.env.VERCEL;
  return secrets.includes(token);
}
