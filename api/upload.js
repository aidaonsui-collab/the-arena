import { put } from "@vercel/blob";
import { verifyPersonalMessageSignature } from "@mysten/sui/verify";

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

function originOk(request) {
  const allow = (process.env.ARENA_ORIGIN || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const host = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "";
  if (host) allow.push(host);
  const origin = request.headers.get("origin") || "";
  if (!origin) return true;
  if (!allow.length) return /the-arena|\.vercel\.app$/i.test(origin);
  return allow.some((a) => origin === a || origin.startsWith(a));
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

async function verifyUploadSig(address, signature, ts) {
  const t = Number(ts);
  if (!address || !signature || !Number.isFinite(t)) return false;
  if (Math.abs(Date.now() - t) > 10 * 60 * 1000) return false;
  const msg = new TextEncoder().encode(`arena-upload:${t}`);
  const pub = await verifyPersonalMessageSignature(msg, signature);
  return pub.toSuiAddress().toLowerCase() === String(address).toLowerCase();
}

export async function POST(request) {
  if (!originOk(request)) {
    return Response.json({ error: "bad origin" }, { status: 403 });
  }
  const address = (request.headers.get("x-sui-address") || "").trim();
  const signature = (request.headers.get("x-sui-signature") || "").trim();
  const ts = (request.headers.get("x-sui-ts") || "").trim();
  try {
    if (!(await verifyUploadSig(address, signature, ts))) {
      return Response.json({ error: "sign arena-upload:<ts> with the connected wallet" }, { status: 401 });
    }
  } catch {
    return Response.json({ error: "invalid upload signature" }, { status: 401 });
  }
  const ip = clientIp(request);
  if (!rateOk(rateKey(ip, address))) {
    return Response.json({ error: "upload quota (8/hour)" }, { status: 429 });
  }
  const buf = Buffer.from(await request.arrayBuffer());
  if (buf.length === 0 || buf.length > MAX) {
    return Response.json({ error: "empty or over 2MB" }, { status: 400 });
  }
  const kind = sniff(buf);
  if (!kind) {
    return Response.json({ error: "png, jpeg, webp, or gif" }, { status: 400 });
  }
  const rawName = request.headers.get("x-filename") || "token";
  const safe = rawName.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 80) || "token";
  const blob = await put(`tokens/${safe}`, buf, {
    access: "public",
    addRandomSuffix: true,
    contentType: kind,
  });
  return Response.json({ url: blob.url });
}
