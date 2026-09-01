const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const EVENT_PKGS = [
  process.env.ARENA_INSTADEX_PACKAGE || "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3",
  "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9",
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

const HIDE = new Set(["BFLN", "GRAD", "SMOKE", "IDEX", "SILVER"]);

async function findLaunch(sym) {
  const want = String(sym || "").toUpperCase();
  if (HIDE.has(want)) return null;
  const q =
    "query($t:String!){ events(first:50, filter:{ type:$t }){ nodes { timestamp contents { json } } } }";
  for (const pkg of EVENT_PKGS) {
    try {
      const data = await gql(q, { t: pkg + "::events::InstadexLaunchEvent" });
      const nodes = (data && data.events && data.events.nodes) || [];
      for (const n of nodes) {
        const p = (n.contents && n.contents.json) || {};
        const ticker = String(p.symbol || "").toUpperCase();
        if (ticker === want) {
          return {
            symbol: ticker,
            name: p.name || ticker,
            token: typeNameOf(p.token),
            quote: quoteLabel(p.quote),
            pool: String(p.bluefin_pool_id || ""),
          };
        }
      }
    } catch (e) {}
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
  const sym = String(t).trim().toUpperCase().slice(0, 12);
  if (!sym) {
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
  const name = (launch && launch.name) || sym;
  const quote = (launch && launch.quote) || "SUI";
  return htmlPage({
    origin,
    title: "$" + sym + " — " + name + " | Vice",
    description: "Instant · Trade in " + quote + " · vicefun.com",
    image: origin + "/card/" + encodeURIComponent(sym) + ".jpg",
    url: origin + "/t/" + encodeURIComponent(sym),
    dest: "/t/" + encodeURIComponent(sym),
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
