/**
 * Tiny HTTP acceptor for attested RH deposits (v1 operator / automation).
 * POST /mint  JSON: { ticker, amount, recipient, rh_tx_hash|rh_ref, dry_run? }
 * Auth: Authorization: Bearer $STOCKS_MINT_SECRET (required if set).
 */
import { createServer } from "node:http";
import { attestAndMint } from "./mint.ts";

export async function runWebhookServer(port = Number(process.env.STOCKS_WEBHOOK_PORT || 8791)) {
  const secret = process.env.STOCKS_MINT_SECRET ?? "";
  const server = createServer(async (req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body, null, 2));
    };
    if (req.method === "GET" && (req.url === "/" || req.url === "/health")) {
      return send(200, { ok: true, service: "keepers-stocks", mint: "POST /mint" });
    }
    if (req.method === "POST" && req.url === "/mint") {
      if (secret) {
        const auth = req.headers.authorization || "";
        if (auth !== `Bearer ${secret}`) return send(401, { error: "unauthorized" });
      }
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      let body: Record<string, unknown>;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      } catch {
        return send(400, { error: "invalid json" });
      }
      try {
        const out = await attestAndMint({
          ticker: String(body.ticker ?? ""),
          amount: String(body.amount ?? ""),
          recipient: String(body.recipient ?? ""),
          rh_tx_hash: body.rh_tx_hash != null ? String(body.rh_tx_hash) : undefined,
          rh_ref: body.rh_ref != null ? String(body.rh_ref) : undefined,
          dry_run: body.dry_run === true || body.dry_run === "1",
        });
        return send(200, out);
      } catch (e) {
        return send(400, { error: e instanceof Error ? e.message : String(e) });
      }
    }
    send(404, { error: "not found" });
  });
  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`keepers-stocks webhook on :${port}  POST /mint`);
  return server;
}
