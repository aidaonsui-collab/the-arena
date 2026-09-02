import { loadTokenOverlay } from "./token-meta.js";

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

const W = 1200;
const H = 630;
const LEFT = 630;
const BG = [18, 8, 20];
const PINK = [255, 46, 166];
const INK = [244, 238, 242];
const MUTED = [168, 152, 168];

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

function quoteLabel(v) {
  const s = typeNameOf(v);
  if (/usdy/i.test(s)) return "USDY";
  if (/xagm/i.test(s)) return "XAGM";
  if (/xaum/i.test(s)) return "XAUM";
  return "SUI";
}

const HIDE = new Set(["BFLN", "GRAD", "SMOKE", "IDEX", "SILVER"]);

async function findLaunch(sym) {
  const want = String(sym || "").toUpperCase();
  if (!want || HIDE.has(want)) return null;
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
        if (String(p.symbol || "").toUpperCase() === want) {
          return {
            symbol: want,
            name: p.name || want,
            token: typeNameOf(p.token),
            quote: quoteLabel(p.quote),
          };
        }
      }
    } catch (e) {}
  }
  return { symbol: want, name: want, token: "", quote: "SUI" };
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
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 32 || buf.length > 3500000) return null;
    const jpeg = buf[0] === 0xff && buf[1] === 0xd8;
    const png = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    return { buf, jpeg, png };
  } catch (e) {
    return null;
  }
}

function fillCanvas(color) {
  const data = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    data[i * 4] = color[0];
    data[i * 4 + 1] = color[1];
    data[i * 4 + 2] = color[2];
    data[i * 4 + 3] = 255;
  }
  return { width: W, height: H, data };
}

function coverBlit(dst, src, dx, dy, size) {
  const scale = Math.max(size / src.width, size / src.height);
  const sw = size / scale;
  const sh = size / scale;
  const sx0 = (src.width - sw) / 2;
  const sy0 = (src.height - sh) / 2;
  for (let y = 0; y < size; y++) {
    const sy = Math.min(src.height - 1, Math.max(0, Math.floor(sy0 + y / scale)));
    const dstRow = (dy + y) * dst.width;
    const srcRow = sy * src.width;
    for (let x = 0; x < size; x++) {
      const sx = Math.min(src.width - 1, Math.max(0, Math.floor(sx0 + x / scale)));
      const si = (srcRow + sx) * 4;
      const di = (dstRow + dx + x) * 4;
      dst.data[di] = src.data[si];
      dst.data[di + 1] = src.data[si + 1];
      dst.data[di + 2] = src.data[si + 2];
      dst.data[di + 3] = 255;
    }
  }
}

function blitGlyph(dst, atlas, g, dx, dy, rgb) {
  for (let y = 0; y < g.h; y++) {
    const py = dy + y;
    if (py < 0 || py >= dst.height) continue;
    for (let x = 0; x < g.w; x++) {
      const px = dx + x;
      if (px < 0 || px >= dst.width) continue;
      const si = ((g.y + y) * atlas.width + (g.x + x)) * 4;
      const a = atlas.data[si + 3] / 255;
      if (a < 0.04) continue;
      const di = (py * dst.width + px) * 4;
      const ia = 1 - a;
      dst.data[di] = Math.round(rgb[0] * a + dst.data[di] * ia);
      dst.data[di + 1] = Math.round(rgb[1] * a + dst.data[di + 1] * ia);
      dst.data[di + 2] = Math.round(rgb[2] * a + dst.data[di + 2] * ia);
    }
  }
}

function measure(font, str, tracking) {
  tracking = tracking || 0;
  const glyphs = font.glyphs;
  let w = 0;
  for (const ch of str) {
    const g = glyphs[ch] || glyphs["?"];
    if (!g) continue;
    w += g.adv + tracking;
  }
  return w;
}

function drawText(dst, atlas, font, str, x, y, rgb, tracking) {
  tracking = tracking || 0;
  const glyphs = font.glyphs;
  let cx = x;
  for (const ch of str) {
    const g = glyphs[ch] || glyphs["?"];
    if (!g) continue;
    blitGlyph(dst, atlas, g, Math.round(cx), Math.round(y + (g.top || 0)), rgb);
    cx += g.adv + tracking;
  }
  return cx;
}

function fitText(font, str, maxW, tracking) {
  if (measure(font, str, tracking) <= maxW) return str;
  const ell = "...";
  let s = str;
  while (s.length && measure(font, s + ell, tracking) > maxW) s = s.slice(0, -1);
  return s + ell;
}

let assets;
async function loadAssets(origin, jpeg, PNG) {
  if (assets) return assets;
  const [fontPng, fontJson] = await Promise.all([
    fetchBuf(origin + "/brand/og-font.png"),
    fetch(origin + "/brand/og-font.json").then(function (r) { return r.ok ? r.json() : null; }),
  ]);
  if (!fontPng || !fontPng.png || !fontJson || !PNG) return null;
  const atlas = PNG.sync.read(fontPng.buf);
  assets = { atlas: { width: atlas.width, height: atlas.height, data: atlas.data }, fonts: fontJson };
  return assets;
}

async function decodeAny(file, jpeg, PNG) {
  if (!file) return null;
  if (file.jpeg && jpeg && jpeg.decode) {
    const im = jpeg.decode(file.buf, { useTArray: true });
    return { width: im.width, height: im.height, data: im.data };
  }
  if (file.png && PNG && PNG.sync) {
    const im = PNG.sync.read(file.buf);
    return { width: im.width, height: im.height, data: im.data };
  }
  return null;
}

async function homeJpg(origin) {
  const r = await fetch(origin + "/brand/share-home.jpg");
  if (!r.ok) throw new Error("share-home");
  const buf = Buffer.from(await r.arrayBuffer());
  return new Response(buf, {
    headers: {
      ...JPG_HEADERS,
      "content-length": String(buf.length),
      "content-disposition": "inline",
    },
  });
}

async function render(request) {
  const origin = originOf(request);
  const t = new URL(request.url).searchParams.get("t") || "";
  const sym = String(t).trim().toUpperCase().slice(0, 12);
  if (!sym) return homeJpg(origin);

  const jpegMod = await import("jpeg-js");
  const jpeg = jpegMod.default && jpegMod.default.decode ? jpegMod.default : jpegMod;
  let PNG = null;
  try {
    const pngMod = await import("pngjs");
    PNG = pngMod.PNG || (pngMod.default && pngMod.default.PNG) || pngMod.default;
  } catch (e) {}

  const launch = await findLaunch(sym);
  const overlay = await loadTokenOverlay(sym);
  const name = (overlay && overlay.name) || (launch && launch.name) || sym;
  const quote = (launch && launch.quote) || "SUI";
  const icon = (overlay && overlay.icon) || (launch && launch.token ? await coinIcon(launch.token) : "");
  const pfpFile = await fetchBuf(icon);
  const pfp = await decodeAny(pfpFile, jpeg, PNG);
  const pack = await loadAssets(origin, jpeg, PNG);
  const dst = fillCanvas(BG);
  if (pfp) coverBlit(dst, pfp, 0, 0, LEFT);

  const x = LEFT + 52;
  const maxW = W - x - 40;
  if (pack) {
    const label = pack.fonts.label;
    const ticker = pack.fonts.ticker;
    const nameF = pack.fonts.name;
    const sub = pack.fonts.sub;
    const tickerStr = fitText(ticker, "$" + sym, maxW, 0);
    const nameStr = fitText(nameF, String(name), maxW, 0);
    const subStr = fitText(sub, "Instant  ·  Trade in " + quote + "  ·  vicefun.com", maxW, 0);
    let y = 150;
    drawText(dst, pack.atlas, label, "VICE", x, y, PINK, 3);
    y += 44;
    drawText(dst, pack.atlas, ticker, tickerStr, x, y, INK, 0);
    y += 86;
    drawText(dst, pack.atlas, nameF, nameStr, x, y, MUTED, 0);
    y += 58;
    drawText(dst, pack.atlas, sub, subStr, x, y, MUTED, 0);
  }

  const out = jpeg.encode(dst, 86);
  return new Response(out.data, {
    headers: {
      ...JPG_HEADERS,
      "content-length": String(out.data.length),
      "content-disposition": "inline",
    },
  });
}

export async function GET(request) {
  const origin = originOf(request);
  try {
    return await render(request);
  } catch (e) {
    try {
      return await homeJpg(origin);
    } catch (e2) {
      return Response.redirect(origin + "/brand/share-home.jpg", 302);
    }
  }
}

export async function HEAD(request) {
  const res = await GET(request);
  return new Response(null, { status: res.status, headers: res.headers });
}
