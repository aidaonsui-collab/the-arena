import { put } from "@vercel/blob";
import { readJsonBlob, rememberJsonBlob } from "./_blob-json.js";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const PLATFORM = normalizeSuiAddress(
  process.env.ARENA_PLATFORM || "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b"
);
const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const EVENT_PKGS = [
  process.env.ARENA_INSTADEX_PACKAGE || "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3",
  process.env.ARENA_COLLECT_PACKAGE || "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9",
  process.env.ARENA_PACKAGE_ID || "0x5cfddf8ba23be6835644a8ea22482ff6ebb0081e42cc1bc052b5f770ca8bbdea",
];
const EVENT_TYPES = ["InstadexLaunchEvent", "LaunchEvent"];
const TICKER_RE = /^[A-Z][A-Z0-9_.\-]{0,15}$/;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 12;
const hits = new Map();

function vercelHost(v) {
  if (!v) return "";
  return v.startsWith("http") ? v.replace(/\/$/, "") : `https://${v}`;
}

function originOk(request) {
  const origin = (request.headers.get("origin") || "").replace(/\/$/, "");
  if (!origin) return true;
  if (/vicefun\.com$/i.test(origin) || /the-arena|\.vercel\.app$/i.test(origin)) return true;
  const allow = (process.env.ARENA_ORIGIN || "")
    .split(",")
    .map((s) => vercelHost(s.trim()))
    .filter(Boolean);
  for (const key of ["VERCEL_URL", "VERCEL_BRANCH_URL", "VERCEL_PROJECT_PRODUCTION_URL"]) {
    const host = vercelHost(process.env[key] || "");
    if (host) allow.push(host);
  }
  return allow.some((a) => origin === a || origin.startsWith(a + "/"));
}

function corsHeaders(request) {
  const origin = request.headers.get("origin") || "*";
  return {
    "access-control-allow-origin": origin,
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    vary: "Origin",
  };
}

function json(body, status, request, extra) {
  return Response.json(body, { status, headers: Object.assign(corsHeaders(request), extra || {}) });
}

function clientIp(request) {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "unknown";
}

function rateOk(key) {
  const now = Date.now();
  const row = hits.get(key) || [];
  const fresh = row.filter((t) => now - t < WINDOW_MS);
  if (fresh.length >= MAX_PER_WINDOW) {
    hits.set(key, fresh);
    return false;
  }
  fresh.push(now);
  hits.set(key, fresh);
  return true;
}

function asString(v) {
  return v == null ? "" : String(v).trim();
}

function safeTicker(v) {
  const t = asString(v).toUpperCase();
  return TICKER_RE.test(t) ? t : "";
}

function normType(t) {
  if (t == null || t === "") return "";
  if (typeof t === "object") {
    if (t.address && t.module) return normType(String(t.address) + "::" + t.module + "::" + (t.name || ""));
    if (t.name) return normType(t.name);
  }
  const s = String(t);
  const parts = s.split("::");
  if (parts.length < 3) return s;
  const addr = parts[0].replace(/^0x/i, "").replace(/^0+/, "") || "0";
  parts[0] = "0x" + addr;
  return parts.join("::");
}

function typeNameOf(v) {
  return normType(v);
}

function sameAddr(a, b) {
  try {
    return normalizeSuiAddress(a) === normalizeSuiAddress(b);
  } catch {
    return false;
  }
}

function blobPath(ticker) {
  return "token-meta/" + ticker + ".json";
}

function httpsUrl(s) {
  try {
    const u = new URL(asString(s));
    if (u.protocol !== "https:") return "";
    if (!u.hostname || u.hostname.indexOf(".") < 0) return "";
    return u.href.replace(/\/$/, "");
  } catch {
    return "";
  }
}

function normX(s) {
  s = asString(s);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!/^(www\.)?(x\.com|twitter\.com)$/i.test(u.hostname)) return "";
      const path = u.pathname.replace(/\/+$/, "");
      if (!path || path === "/") return "";
      return "https://x.com" + path;
    } catch {
      return "";
    }
  }
  s = s.replace(/^@/, "").replace(/^(https?:\/\/)?(www\.)?(x|twitter)\.com\//i, "");
  s = s.split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{1,15}$/.test(s)) return "";
  return "https://x.com/" + s;
}

function normTg(s) {
  s = asString(s);
  if (!s) return "";
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!/^(www\.)?(t\.me|telegram\.me)$/i.test(u.hostname)) return "";
      const path = u.pathname.replace(/\/+$/, "");
      if (!path || path === "/") return "";
      return "https://t.me" + path;
    } catch {
      return "";
    }
  }
  s = s.replace(/^@/, "").replace(/^(https?:\/\/)?(www\.)?(t|telegram)\.me\//i, "");
  s = s.split(/[/?#]/)[0];
  if (!/^[A-Za-z0-9_]{3,32}$/.test(s)) return "";
  return "https://t.me/" + s;
}

function normWeb(s) {
  s = asString(s);
  if (!s) return "";
  if (!/^https?:\/\//i.test(s)) s = "https://" + s;
  return httpsUrl(s);
}

function requireSocial(kind, raw, normed) {
  if (!asString(raw)) return "";
  if (!normed) throw new Error("Invalid " + kind + " link");
  return normed;
}

function publicMeta(row) {
  if (!row) return null;
  return {
    ticker: row.ticker || "",
    type: row.type || "",
    name: row.name || "",
    description: row.description || "",
    twitter: row.twitter || "",
    telegram: row.telegram || "",
    website: row.website || "",
    icon: row.icon || "",
    creator: row.creator || "",
    updatedAt: row.updatedAt || 0,
    role: row.role || "",
  };
}

export async function loadTokenOverlay(ticker) {
  const t = safeTicker(ticker);
  if (!t) return null;
  const row = await readJsonBlob(blobPath(t), null);
  if (!row || typeof row !== "object") return null;
  return publicMeta(row);
}

async function gql(query, variables) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j && j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql");
  return j && j.data;
}

async function findLaunch(ticker, coinType) {
  const want = safeTicker(ticker);
  const wantType = normType(coinType);
  if (!want && !wantType) return null;
  const q =
    "query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { contents { json } } } }";
  for (const pkg of EVENT_PKGS) {
    for (const kind of EVENT_TYPES) {
      let after = null;
      for (let i = 0; i < 12; i++) {
        let data;
        try {
          data = await gql(q, { t: pkg + "::events::" + kind, first: 50, after });
        } catch {
          break;
        }
        const nodes = (data && data.events && data.events.nodes) || [];
        for (const n of nodes) {
          const p = (n.contents && n.contents.json) || {};
          const symbol = String(p.symbol || "").toUpperCase();
          const token = typeNameOf(p.token);
          const hit = (want && symbol === want) || (wantType && token && normType(token) === wantType);
          if (!hit) continue;
          return {
            ticker: symbol || want,
            type: token || wantType,
            creator: asString(p.creator),
            lockId: asString(p.lock_id),
            name: asString(p.name),
          };
        }
        const page = data && data.events && data.events.pageInfo;
        if (!page || !page.hasNextPage || !page.endCursor) break;
        after = page.endCursor;
      }
    }
  }
  return null;
}

async function verifyMetaSig(address, signature, ts, coinType) {
  const t = Number(ts);
  if (!address || !signature || !Number.isFinite(t)) return false;
  if (Math.abs(Date.now() - t) > 10 * 60 * 1000) return false;
  const addr = normalizeSuiAddress(address);
  const msg = new TextEncoder().encode("vice-meta:" + t + ":" + normType(coinType));
  const pub = await verifyPersonalMessageSignature(msg, signature, { address: addr });
  return normalizeSuiAddress(pub.toSuiAddress()) === addr;
}

function addrOf(v) {
  try {
    return normalizeSuiAddress(asString(v));
  } catch {
    return "";
  }
}

async function lockBeneficiary(lockId) {
  const id = asString(lockId);
  if (!id) return "";
  try {
    const data = await gql(
      "query($id:SuiAddress!){ object(address:$id){ asMoveObject { contents { json } } } }",
      { id }
    );
    const json =
      data &&
      data.object &&
      data.object.asMoveObject &&
      data.object.asMoveObject.contents &&
      data.object.asMoveObject.contents.json;
    return addrOf(json && json.beneficiary);
  } catch {
    return "";
  }
}

async function assertEditor(address, ticker, coinType, ctx) {
  const addr = normalizeSuiAddress(address);
  if (addr === PLATFORM) return "platform";
  const overlay = ctx && "overlay" in ctx ? ctx.overlay : await loadTokenOverlay(ticker);
  if (overlay && overlay.creator && sameAddr(addr, overlay.creator)) return "creator";
  const launch = ctx && "launch" in ctx ? ctx.launch : await findLaunch(ticker, coinType);
  if (launch && wantTypeMismatch(launch, coinType)) throw new Error("Token type does not match this ticker");
  let ben = ctx && ctx.beneficiary;
  if (!ben && launch && launch.lockId) ben = await lockBeneficiary(launch.lockId);
  if (ben && sameAddr(addr, ben)) return "creator";
  if (!ben && launch && launch.creator && sameAddr(addr, launch.creator)) return "creator";
  throw new Error("Only the current creator or platform wallet can update this page");
}

function wantTypeMismatch(launch, coinType) {
  const a = normType(launch && launch.type);
  const b = normType(coinType);
  return !!(a && b && a !== b);
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function GET(request) {
  const url = new URL(request.url);
  const ticker = safeTicker(url.searchParams.get("t") || url.searchParams.get("ticker"));
  if (!ticker) return json({ error: "ticker required" }, 400, request);
  const meta = await loadTokenOverlay(ticker);
  return json({ meta }, 200, request, {
    "cache-control": "public, s-maxage=30, stale-while-revalidate=120",
  });
}

export async function POST(request) {
  if (!originOk(request)) return json({ error: "bad origin" }, 403, request);
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ error: "invalid json" }, 400, request);
  }
  const ticker = safeTicker(body && (body.ticker || body.t));
  const coinType = normType(body && body.type);
  const address = asString(body && body.address);
  const rawSig = body && body.signature;
  const signature = asString(rawSig && typeof rawSig === "object" ? rawSig.signature : rawSig);
  const ts = asString(body && body.ts);
  if (!ticker) return json({ error: "ticker required" }, 400, request);
  if (!coinType || coinType.indexOf("::") < 0) return json({ error: "coin type required" }, 400, request);
  try {
    if (!(await verifyMetaSig(address, signature, ts, coinType))) {
      return json({ error: "sign vice-meta:<ts>:<type> with the connected wallet" }, 401, request);
    }
  } catch (e) {
    const why = e && e.message ? String(e.message) : "invalid signature";
    return json({ error: why.slice(0, 180) }, 401, request);
  }
  const ip = clientIp(request);
  if (!rateOk(ip + ":" + address)) return json({ error: "update quota (12/hour)" }, 429, request);

  const overlay = await loadTokenOverlay(ticker);
  let creatorNext = "";
  if (Object.prototype.hasOwnProperty.call(body, "creator")) {
    const rawCreator = asString(body.creator);
    if (rawCreator) {
      try {
        creatorNext = normalizeSuiAddress(rawCreator);
      } catch {
        return json({ error: "creator wallet must be a Sui address" }, 400, request);
      }
    }
  }
  const creatorChanging = !!(
    creatorNext &&
    (!overlay || !overlay.creator || !sameAddr(creatorNext, overlay.creator))
  );
  let launch = null;
  let beneficiary = "";
  if (creatorChanging) {
    launch = await findLaunch(ticker, coinType);
    if (launch && wantTypeMismatch(launch, coinType)) {
      return json({ error: "Token type does not match this ticker" }, 400, request);
    }
    if (launch && launch.lockId) beneficiary = await lockBeneficiary(launch.lockId);
    if (beneficiary && !sameAddr(creatorNext, beneficiary)) {
      return json({ error: "creator wallet must match the on-chain rewards beneficiary" }, 400, request);
    }
  }

  const editorCtx = { overlay };
  if (creatorChanging) {
    editorCtx.launch = launch;
    editorCtx.beneficiary = beneficiary;
  }

  let role;
  try {
    role = await assertEditor(address, ticker, coinType, editorCtx);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "not allowed";
    const status = /not found/i.test(why) ? 404 : 403;
    return json({ error: why.slice(0, 180) }, status, request);
  }

  let twitter;
  let telegram;
  let website;
  try {
    twitter = requireSocial("X", body.twitter, normX(body.twitter));
    telegram = requireSocial("Telegram", body.telegram, normTg(body.telegram));
    website = requireSocial("website", body.website, normWeb(body.website));
  } catch (e) {
    return json({ error: (e && e.message) || "invalid social link" }, 400, request);
  }

  const prev = overlay || {};
  const description = asString(body.description).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").slice(0, 512);
  const name = asString(body.name).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, 48);
  let icon = httpsUrl(body.icon);
  if (asString(body.icon) && !icon) return json({ error: "icon must be an https URL" }, 400, request);
  if (!icon) icon = prev.icon || "";
  let creator = prev.creator || "";
  if (creatorNext) creator = creatorNext;

  const row = {
    ticker,
    type: coinType,
    name,
    description,
    twitter,
    telegram,
    website,
    icon,
    creator,
    updatedAt: Date.now(),
    updatedBy: normalizeSuiAddress(address),
    role,
  };
  try {
    await put(blobPath(ticker), JSON.stringify(row), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 15,
    });
    rememberJsonBlob(blobPath(ticker), row);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return json({ error: why.slice(0, 180) }, 502, request);
  }
  return json({ meta: publicMeta(row) }, 200, request);
}
