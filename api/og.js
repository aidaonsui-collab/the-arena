import { createRequire } from "module";
const jpeg = createRequire(import.meta.url)("jpeg-js");

const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const RPC = process.env.SUI_RPC || "https://mainnet.suiet.app";
const EVENT_PKGS = [
  process.env.ARENA_INSTADEX_PACKAGE || "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3",
  "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9",
];

const JPG_HEADERS = {
  "content-type": "image/jpeg",
  "cache-control": "public, s-maxage=600, stale-while-revalidate=86400",
};

function originOf(request) {
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "vicefun.com")
    .split(",")[0]
    .trim();
  const proto = request.headers.get("x-forwarded-proto") || "https";
  return proto + "://" + host.replace(/\/$/, "");
}

function typeNameOf(v) {
  if (v == null || v === "") return "";
  if (typeof v === "string") {
    if (v.includes("::") && !v.startsWith("0x") && !v.startsWith("0X")) return "0x" + v;
    return v;
  }
  if (typeof v === "object") {
    if (v.address && v.module) return String(v.address) + "::" + v.module + "::" + (v.name || "");
    if (v.name) return typeNameOf(String(v.name));
  }
  return String(v);
}

async function findToken(sym) {
  const want = String(sym || "").toUpperCase();
  if (!want) return "";
  const q =
    "query($t:String!){ events(first:50, filter:{ type:$t }){ nodes { contents { json } } } }";
  for (const pkg of EVENT_PKGS) {
    try {
      const r = await fetch(GQL, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ query: q, variables: { t: pkg + "::events::InstadexLaunchEvent" } }),
      });
      const j = await r.json();
      const nodes = (j && j.data && j.data.events && j.data.events.nodes) || [];
      for (const n of nodes) {
        const p = (n.contents && n.contents.json) || {};
        if (String(p.symbol || "").toUpperCase() === want) return typeNameOf(p.token);
      }
    } catch (e) {}
  }
  return "";
}

async function coinIcon(type) {
  if (!type) return "";
  try {
    const r = await fetch(RPC, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "suix_getCoinMetadata", params: [type] }),
    });
    const j = await r.json();
    const meta = j && j.result;
    return (meta && (meta.iconUrl || meta.icon_url)) || "";
  } catch (e) {
    return "";
  }
}

async function fetchBuf(url) {
  if (!url) return null;
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    const ct = (r.headers.get("content-type") || "").toLowerCase();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 32 || buf.length > 3500000) return null;
    return { buf, jpeg: ct.includes("jpeg") || ct.includes("jpg") || buf[0] === 0xff && buf[1] === 0xd8 };
  } catch (e) {
    return null;
  }
}

function coverBlit(dst, src, dx, dy, size) {
  const scale = Math.max(size / src.width, size / src.height);
  const sw = size / scale;
  const sh = size / scale;
  const sx0 = (src.width - sw) / 2;
  const sy0 = (src.height - sh) / 2;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, Math.floor(sy0 + y / scale)));
    for (let x = 0; x < size; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, Math.floor(sx0 + x / scale)));
      const si = (sy * src.width + sx) * 4;
      const di = ((dy + y) * dst.width + (dx + x)) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = 255;
    }
  }
}

function strokeRect(dst, x, y, size, rgb, w) {
  const [r, g, b] = rgb;
  function px(px, py) {
    if (px < 0 || py < 0 || px >= dst.width || py >= dst.height) return;
    const i = (py * dst.width + px) * 4;
    dst.data[i] = r;
    dst.data[i + 1] = g;
    dst.data[i + 2] = b;
    dst.data[i + 3] = 255;
  }
  for (let t = 0; t < w; t++) {
    for (let i = 0; i < size; i++) {
      px(x + i, y + t);
      px(x + i, y + size - 1 - t);
      px(x + t, y + i);
      px(x + size - 1 - t, y + i);
    }
  }
}

function jpgResponse(buf) {
  return new Response(buf, { headers: JPG_HEADERS });
}

async function render(request) {
  const origin = originOf(request);
  const t = new URL(request.url).searchParams.get("t") || "";
  const sym = String(t).trim().toUpperCase().slice(0, 12);
  const bgFile = await fetchBuf(origin + "/brand/og.jpg");
  if (!bgFile) throw new Error("missing og.jpg");
  if (!sym) return jpgResponse(bgFile.buf);

  const type = await findToken(sym);
  const icon = type ? await coinIcon(type) : "";
  const pfpFile = await fetchBuf(icon);
  if (!pfpFile || !pfpFile.jpeg) return jpgResponse(bgFile.buf);

  const bg = jpeg.decode(bgFile.buf, { useTArray: true });
  const pfp = jpeg.decode(pfpFile.buf, { useTArray: true });
  const size = 248;
  const dx = 64;
  const dy = Math.floor((bg.height - size) / 2);
  coverBlit(bg, pfp, dx, dy, size);
  strokeRect(bg, dx - 4, dy - 4, size + 8, [255, 46, 166], 4);
  const out = jpeg.encode(bg, 84);
  return jpgResponse(out.data);
}

export async function GET(request) {
  try {
    return await render(request);
  } catch (e) {
    const origin = originOf(request);
    return Response.redirect(origin + "/brand/og.jpg?v=2", 302);
  }
}

export async function HEAD(request) {
  const res = await GET(request);
  return new Response(null, { status: res.status, headers: res.headers });
}
