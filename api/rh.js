/**
 * Same-origin JSON-RPC proxy for Robinhood Chain.
 *
 * The public RH endpoint intermittently answers with a duplicated
 * `Access-Control-Allow-Origin: *,*` header, which browsers reject outright —
 * measured at roughly half of requests. Anything in the pad that reads RH
 * directly from the browser therefore fails at random: the redeem preflight
 * (which fails closed and refuses a legitimate burn) and the pending-deposit
 * list both depend on it.
 *
 * Proxying server-side removes the browser from that equation entirely.
 *
 * Only read-only methods are forwarded, and only to the configured RH endpoint,
 * so this cannot be repurposed as an open relay or used to broadcast anything.
 */
const RH_RPC = process.env.RH_RPC || "https://rpc.mainnet.chain.robinhood.com";

/** Read-only methods the pad actually needs. Nothing state-changing. */
const ALLOWED = new Set([
  "eth_call",
  "eth_getLogs",
  "eth_blockNumber",
  "eth_getBlockByNumber",
  "eth_getTransactionReceipt",
  "eth_chainId",
]);

const MAX_BODY = 32 * 1024;

function bad(message, status = 400) {
  return Response.json({ error: message }, { status });
}

export async function POST(request) {
  let payload;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY) return bad("payload too large", 413);
    payload = JSON.parse(raw);
  } catch {
    return bad("invalid JSON body");
  }

  // Accept a single call or a batch, but bound the batch so this cannot be
  // used to amplify load against the upstream node.
  const calls = Array.isArray(payload) ? payload : [payload];
  if (!calls.length) return bad("empty request");
  if (calls.length > 20) return bad("batch too large", 413);

  for (const c of calls) {
    if (!c || typeof c.method !== "string") return bad("missing method");
    if (!ALLOWED.has(c.method)) return bad(`method not allowed: ${c.method}`, 403);
  }

  let upstream;
  try {
    upstream = await fetch(RH_RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
      cache: "no-store",
    });
  } catch (e) {
    return Response.json(
      { error: `RH RPC unreachable: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return Response.json({ error: "RH RPC returned non-JSON" }, { status: 502 });
  }

  // Re-serialise rather than streaming the upstream response through, so the
  // malformed CORS headers never reach the browser.
  return new Response(JSON.stringify(json), {
    status: upstream.ok ? 200 : upstream.status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}
