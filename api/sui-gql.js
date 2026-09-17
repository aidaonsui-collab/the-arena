/**
 * Same-origin proxy for Sui GraphQL.
 *
 * graphql.mainnet.sui.io sends no Access-Control-Allow-Origin, so every
 * browser call to it from the pad is blocked before it leaves. Most callers
 * wrap gql() in a try/catch and quietly degrade, which is why the site looks
 * fine — but coinsOfExact() does not, so the bridge burn surfaced it as a bare
 * "Failed to fetch" and the redeem path could never complete. There are zero
 * RedeemBurned events on mainnet, consistent with it never having worked from
 * the deployed site.
 *
 * Proxying server-side removes the browser from the CORS equation, and fixes
 * every gql() call site at once rather than one of them.
 *
 * Read-only: Sui GraphQL exposes executeTransactionBlock as a mutation, so
 * mutations are refused here. Signing and submitting stays on the client.
 */
const SUI_GRAPHQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const MAX_BODY = 64 * 1024;

function bad(message, status = 400) {
  return Response.json({ errors: [{ message }] }, { status });
}

export async function POST(request) {
  let raw;
  try {
    raw = await request.text();
  } catch {
    return bad("unreadable body");
  }
  if (raw.length > MAX_BODY) return bad("payload too large", 413);

  let payload;
  try {
    payload = JSON.parse(raw);
  } catch {
    return bad("invalid JSON body");
  }

  const query = String((payload && payload.query) || "");
  if (!query.trim()) return bad("missing query");
  // Strip comments and string literals before looking for an operation
  // keyword, so "mutation" inside a value cannot trip this and, more
  // importantly, cannot hide one either.
  const stripped = query.replace(/#[^\n]*/g, " ").replace(/"(?:[^"\\]|\\.)*"/g, '""');
  if (/(^|[\s{])mutation\b/i.test(stripped)) {
    return bad("mutations are not proxied", 403);
  }

  let upstream;
  try {
    upstream = await fetch(SUI_GRAPHQL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, variables: (payload && payload.variables) || {} }),
      cache: "no-store",
    });
  } catch (e) {
    return Response.json(
      { errors: [{ message: `sui graphql unreachable: ${e instanceof Error ? e.message : String(e)}` }] },
      { status: 502 },
    );
  }

  const text = await upstream.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    return Response.json({ errors: [{ message: "sui graphql returned non-JSON" }] }, { status: 502 });
  }

  // Re-serialise rather than streaming upstream headers through.
  return new Response(JSON.stringify(json), {
    status: upstream.ok ? 200 : upstream.status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}
