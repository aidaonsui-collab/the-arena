// zkLogin signature verification client compatible with the current Sui GraphQL schema.
//
// @mysten/sui 1.x's built-in GraphQL client selects `success` AND `error` on
// ZkLoginVerifyResult. Mainnet GraphQL has since removed `error` (the type now only
// exposes `success: Boolean`), so every zkLogin (e.g. Slush Google login) signature
// check failed with: Unknown field "error" on type "ZkLoginVerifyResult".
//
// verifyPersonalMessageSignature() accepts a `client` option that only needs a
// `core.verifyZkLoginSignature()` method, so we supply one that selects `success`
// only and treats it as the source of truth.

const SUI_GRAPHQL_URL = process.env.SUI_GRAPHQL_URL || "https://graphql.mainnet.sui.io/graphql";

const VERIFY_ZKLOGIN_QUERY = `query VerifyZkLogin($bytes: Base64!, $signature: Base64!, $intentScope: ZkLoginIntentScope!, $author: SuiAddress!) {
  verifyZkLoginSignature(bytes: $bytes, signature: $signature, intentScope: $intentScope, author: $author) {
    success
  }
}`;

async function verifyZkLoginSignature({ bytes, signature, intentScope, author }) {
  const res = await fetch(SUI_GRAPHQL_URL, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      query: VERIFY_ZKLOGIN_QUERY,
      variables: {
        bytes,
        signature,
        intentScope: intentScope === "TransactionData" ? "TRANSACTION_DATA" : "PERSONAL_MESSAGE",
        author,
      },
    }),
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    body = null;
  }
  const result = body && body.data ? body.data.verifyZkLoginSignature : null;
  const errors = [];
  if (body && Array.isArray(body.errors)) {
    for (const e of body.errors) errors.push(String((e && e.message) || e));
  }
  // Older schemas exposed `error`/`errors` on the result; honour them if ever present.
  if (result && result.error) errors.push(String(result.error));
  if (result && Array.isArray(result.errors)) errors.push(...result.errors.map(String));
  if (!res.ok && !errors.length) errors.push("Sui GraphQL HTTP " + res.status);
  return { success: !!(result && result.success === true), errors };
}

export const zkLoginVerifyClient = { core: { verifyZkLoginSignature } };
