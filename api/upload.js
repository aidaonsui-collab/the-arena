import { put } from "@vercel/blob";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";
import { normalizeSuiAddress } from "@mysten/sui/utils";

const MAX = 2 * 1024 * 1024;
const WINDOW_MS = 60 * 60 * 1000;
const MAX_PER_WINDOW = 8;
const hits = new Map();

function sniff(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  if (
    buf.length >= 6 &&
    (buf.toString("ascii", 0, 6) === "GIF87a" || buf.toString("ascii", 0, 6) === "GIF89a")
  ) {
    return "image/gif";
  }
  return null;
}

function vercelHost(v) {
  if (!v) return "";
  return v.startsWith("http") ? v.replace(/\/$/, "") : `https://${v}`;
}

function originOk(request) {
  const origin = (request.headers.get("origin") || "").replace(/\/$/, "");
  if (!origin) return true;
  // Production is served on aliases (the-arena-vert.vercel.app). VERCEL_URL is the
  // unique deployment host, so it must not be the only allowed origin.
  if (/the-arena|\.vercel\.app$/i.test(origin)) return true;
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
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-filename, x-sui-address, x-sui-signature, x-sui-ts",
    vary: "Origin",
  };
}

function json(body, status, request) {
  return Response.json(body, { status, headers: corsHeaders(request) });
}

function rateKey(ip, addr) {
  return `${ip || "noip"}:${addr || "noaddr"}`;
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

function clientIp(request) {
  const fwd = request.headers.get("x-forwarded-for") || "";
  return fwd.split(",")[0].trim() || "unknown";
}

function asString(v) {
  if (v == null) return "";
  if (typeof v === "string") return v.trim();
  if (typeof v === "object" && typeof v.signature === "string") return v.signature.trim();
  return String(v).trim();
}

async function readUpload(request) {
  const ct = request.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await request.formData();
    const file = form.get("file");
    let buf = Buffer.alloc(0);
    let filename = asString(form.get("filename")) || "token";
    if (file && typeof file.arrayBuffer === "function") {
      buf = Buffer.from(await file.arrayBuffer());
      filename = file.name || filename;
    }
    return {
      address: asString(form.get("address")),
      signature: asString(form.get("signature")),
      ts: asString(form.get("ts")),
      buf,
      filename,
    };
  }
  return {
    address: asString(request.headers.get("x-sui-address")),
    signature: asString(request.headers.get("x-sui-signature")),
    ts: asString(request.headers.get("x-sui-ts")),
    buf: Buffer.from(await request.arrayBuffer()),
    filename: asString(request.headers.get("x-filename")) || "token",
  };
}

async function verifyUploadSig(address, signature, ts) {
  const t = Number(ts);
  if (!address || !signature || !Number.isFinite(t)) return false;
  if (Math.abs(Date.now() - t) > 10 * 60 * 1000) return false;
  const addr = normalizeSuiAddress(address);
  const msg = new TextEncoder().encode(`arena-upload:${t}`);
  const pub = await verifyPersonalMessageSignature(msg, signature, { address: addr });
  return normalizeSuiAddress(pub.toSuiAddress()) === addr;
}

export function OPTIONS(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

export async function POST(request) {
  if (!originOk(request)) {
    return json({ error: "bad origin" }, 403, request);
  }
  let address;
  let signature;
  let ts;
  let buf;
  let filename;
  try {
    ({ address, signature, ts, buf, filename } = await readUpload(request));
  } catch {
    return json({ error: "could not read upload" }, 400, request);
  }
  try {
    if (!(await verifyUploadSig(address, signature, ts))) {
      return json({ error: "sign arena-upload:<ts> with the connected wallet" }, 401, request);
    }
  } catch (e) {
    const why = e && e.message ? String(e.message) : "invalid upload signature";
    return json({ error: why.slice(0, 180) }, 401, request);
  }
  const ip = clientIp(request);
  if (!rateOk(rateKey(ip, address))) {
    return json({ error: "upload quota (8/hour)" }, 429, request);
  }
  if (buf.length === 0 || buf.length > MAX) {
    return json({ error: "empty or over 2MB" }, 400, request);
  }
  const kind = sniff(buf);
  if (!kind) {
    return json({ error: "png, jpeg, webp, or gif" }, 400, request);
  }
  const safe = String(filename || "token").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "token";
  try {
    const blob = await put(`tokens/${safe}`, buf, {
      access: "public",
      addRandomSuffix: true,
      contentType: kind,
    });
    return json({ url: blob.url }, 200, request);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return json({ error: why.slice(0, 180) }, 502, request);
  }
}
