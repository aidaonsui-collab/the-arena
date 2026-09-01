const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const RPC = process.env.SUI_RPC || "https://mainnet.suiet.app";
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

async function rpc(method, params) {
  const r = await fetch(RPC, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || method);
  return j.result;
}

async function findLaunch(sym) {
  const want = String(sym || "").toUpperCase();
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

async function coinIcon(type) {
  if (!type) return "";
  try {
    const meta = await rpc("suix_getCoinMetadata", [type]);
    return (meta && (meta.iconUrl || meta.icon_url)) || "";
  } catch (e) {
    return "";
  }
}

function htmlPage({ origin, title, description, image, card, url, dest }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Vice">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:alt" content="${esc(title)}">
<meta name="twitter:card" content="${esc(card)}">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${esc(image)}">
<link rel="canonical" href="${esc(url)}">
<meta http-equiv="refresh" content="0;url=${esc(dest)}">
<script>location.replace(${JSON.stringify(dest)});</script>
</head>
<body style="background:#120814;color:#F4EEF2;font-family:sans-serif;padding:40px">
<a href="${esc(dest)}" style="color:#FF2EA6">${esc(title)} on Vice</a>
</body>
</html>`;
}

export async function GET(request) {
  const origin = originOf(request);
  const t = new URL(request.url).searchParams.get("t") || "";
  const sym = String(t).trim().toUpperCase().slice(0, 12);
  const siteImage = origin + "/brand/og.jpg";
  if (!sym) {
    return new Response(
      htmlPage({
        origin,
        title: "Vice",
        description: "Straight to DEX launches. Pair with Sui or RWA's",
        image: siteImage,
        card: "summary_large_image",
        url: origin + "/",
        dest: "/",
      }),
      { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, s-maxage=300" } }
    );
  }
  const launch = await findLaunch(sym);
  const icon = launch ? await coinIcon(launch.token) : "";
  const name = (launch && launch.name) || sym;
  const quote = (launch && launch.quote) || "SUI";
  const title = name + " (" + sym + ")";
  const description = sym + " / " + quote + " on Vice. Straight to DEX launches.";
  const image = icon || siteImage;
  const card = icon ? "summary" : "summary_large_image";
  const url = origin + "/t/" + encodeURIComponent(sym);
  const dest = "/#/token/" + encodeURIComponent(sym);
  return new Response(
    htmlPage({ origin, title, description, image, card, url, dest }),
    {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "public, s-maxage=60, stale-while-revalidate=300",
      },
    }
  );
}
