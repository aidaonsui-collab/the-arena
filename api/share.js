import { loadTokenOverlay } from "./token-meta.js";

const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const EVENT_PKGS = [
  process.env.ARENA_INSTADEX_PACKAGE || "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3",
  "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9",
  process.env.ARENA_CALL_PACKAGE || "0x1c808e5fe7f14703a72cae3cd71ebba98b3a9a97dc530feed6222595bfb4a853",
  "0x3ccc57531949d6f24178bd57fe20496ee4ff515e26c280f1b80f658bc020bcbe",
];

function originOf(request) {
  const host = (request.headers.get("x-forwarded-host") || request.headers.get("host") || "vicefun.com")
    .split(",")[0]
    .trim();
  const proto = request.headers.get("x-forwarded-proto") || "https";
  return proto + "://" + host.replace(/\/$/, "");
}

function esc(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/"/g, "&quot;");
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
  if (/nvda/i.test(s)) return "NVDA";
  if (/amc/i.test(s)) return "AMC";
  if (/vicefun/i.test(s)) return "VICEFUN";
  if (/::axol::AXOL/i.test(s) || s === "AXOL") return "AXOL";
  if (/::LOFI::LOFI/i.test(s) || s === "LOFI") return "LOFI";
  if (/::manifest::MANIFEST/i.test(s) || s === "MANIFEST") return "MANIFEST";
  if (/::wal::WAL/i.test(s) || s === "WAL") return "WAL";
  if (/::deep::DEEP/i.test(s) || s === "DEEP") return "DEEP";
  if (/::ns::NS/i.test(s) || s === "NS") return "NS";
  if (/::sca::SCA/i.test(s) || s === "SCA") return "SCA";
  if (/::blue::BLUE/i.test(s) || s === "BLUE") return "BLUE";
  return "SUI";
}

async function gql(query, variables) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql");
  return j.data;
}

const HIDE = new Set(["BFLN", "GRAD", "SMOKE", "IDEX", "SILVER", "NNCAT"]);
const HIDE_TYPES = new Set([
  "0xa0b937f9f6c7cd7e865b3c5bde42dc21dee8e847a7226e6de3aa9af4f64059b4::ncat::ncat",
  "0xbe1af5ef6e6ffa70a298947fd173932e24f98aa1488d77875bee1eff747e107c::nncat::nncat",
]);

// Token pages are linked by bare package address as well as by symbol
// (tokenRouteId prefers the package), so a hidden coin type has to match
// on its package too or /t/0x<pkg> still renders a card.
const HIDE_PKGS = new Set(
  [...HIDE_TYPES].map((t) => String(t).split("::")[0].toLowerCase())
);

function isHiddenReq(s) {
  const raw = String(s || "").trim();
  const key = normType(raw).toLowerCase();
  if (HIDE.has(raw.toUpperCase()) || HIDE_TYPES.has(key)) return true;
  return !key.includes("::") && HIDE_PKGS.has(key);
}

function normType(s) {
  s = String(s || "").trim();
  if (!s) return "";
  if (s.startsWith("0X")) s = "0x" + s.slice(2);
  return s;
}

async function findLaunch(sym) {
  const raw = String(sym || "").trim();
  const want = raw.toUpperCase();
  const wantType = normType(raw).toLowerCase();
  if (HIDE.has(want) || HIDE_TYPES.has(wantType)) return null;
  const q =
    "query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { timestamp contents { json } } } }";
  for (const pkg of EVENT_PKGS) {
    let after = null;
    for (let page = 0; page < 12; page++) {
      try {
        const data = await gql(q, { t: pkg + "::events::InstadexLaunchEvent", first: 50, after });
        const nodes = (data && data.events && data.events.nodes) || [];
        for (const n of nodes) {
          const p = (n.contents && n.contents.json) || {};
          const ticker = String(p.symbol || "").toUpperCase();
          const token = typeNameOf(p.token);
          const tokenKey = normType(token).toLowerCase();
          if (HIDE_TYPES.has(tokenKey)) continue;
          const typeHit = wantType.includes("::") && tokenKey === wantType;
          const pkgHit = /^0x[0-9a-f]+$/i.test(raw) && tokenKey.split("::")[0] === wantType;
          if (ticker === want || typeHit || pkgHit) {
            return {
              symbol: ticker,
              name: p.name || ticker,
              token: token,
              quote: quoteLabel(p.quote),
              pool: String(p.bluefin_pool_id || ""),
            };
          }
        }
        const info = data && data.events && data.events.pageInfo;
        if (!info || !info.hasNextPage || !info.endCursor) break;
        after = info.endCursor;
      } catch (e) {
        break;
      }
    }
  }
  return null;
}

function htmlPage({ origin, title, description, image, url, dest, imageType }) {
  const type = imageType || (/\.png(\?|$)/i.test(image) ? "image/png" : "image/jpeg");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta name="theme-color" content="#FF2EA6">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vice">
<meta property="og:locale" content="en_US">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:secure_url" content="${esc(image)}">
<meta property="og:image:type" content="${esc(type)}">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:width" content="1200">
<meta name="twitter:image:height" content="630">
<meta name="twitter:image:alt" content="${esc(title)}">
<link rel="canonical" href="${esc(url)}">
<link rel="image_src" href="${esc(image)}">
<link rel="icon" href="${esc(origin)}/brand/favicon.png" type="image/png">
</head>
<body style="background:#120814;color:#F4EEF2;font-family:sans-serif;padding:40px;max-width:720px">
<img src="${esc(image)}" alt="${esc(title)}" width="1200" height="630" style="max-width:100%;height:auto;border-radius:16px">
<h1 style="font-size:28px;margin:24px 0 8px">${esc(title)}</h1>
<p style="color:#A898A8">${esc(description)}</p>
<p><a href="${esc(dest)}" style="color:#FF2EA6">${esc(title)} on Vice</a></p>
</body>
</html>`;
}

async function page(request) {
  const origin = originOf(request);
  const t = new URL(request.url).searchParams.get("t") || "";
  const raw = String(t).trim();
  const isType = raw.includes("::") || /^0x[0-9a-fA-F]{40,}$/i.test(raw);
  const sym = isType ? raw : raw.toUpperCase().slice(0, 12);
  // A hidden token must fall back to the plain site card. findLaunch()
  // returning null is not enough: the token branch below derives its title
  // from `sym` itself, so it would still render "$SYM - SYM | Vice".
  if (!sym || isHiddenReq(sym)) {
    return htmlPage({
      origin,
      title: "Vice — Fair launches on Sui",
      description: "Straight to DEX launches. Pair with Sui or RWA's",
      image: origin + "/og.png",
      url: origin,
      dest: "/",
      imageType: "image/png",
    });
  }
  const launch = await findLaunch(sym);
  const overlay = await loadTokenOverlay((launch && launch.symbol) || (!isType ? sym : ""));
  const name = (overlay && overlay.name) || (launch && launch.name) || (launch && launch.symbol) || sym;
  const quote = (launch && launch.quote) || "SUI";
  const tick = (launch && launch.symbol) || (!isType ? sym : name);
  const pkg = launch && launch.token ? String(launch.token).split("::")[0] : "";
  const slug = pkg || (launch && launch.token) || tick;
  const desc = (overlay && overlay.description)
    ? String(overlay.description).split(/\n/)[0].slice(0, 160)
    : ("Instant · Trade in " + quote + " · vicefun.com");
  return htmlPage({
    origin,
    title: "$" + tick + " — " + name + " | Vice",
    description: desc,
    image: origin + "/card/" + encodeURIComponent(tick) + ".jpg" + (overlay && overlay.updatedAt ? "?v=" + overlay.updatedAt : ""),
    url: origin + "/t/" + encodeURIComponent(slug),
    dest: "/t/" + encodeURIComponent(slug),
    imageType: "image/jpeg",
  });
}

const HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "public, s-maxage=120, stale-while-revalidate=86400",
};

export async function GET(request) {
  const body = await page(request);
  return new Response(body, { headers: HEADERS });
}

export async function HEAD(request) {
  const body = await page(request);
  return new Response(null, {
    status: 200,
    headers: {
      ...HEADERS,
      "content-length": String(new TextEncoder().encode(body).length),
    },
  });
}
