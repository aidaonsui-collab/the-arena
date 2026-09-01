import { ImageResponse } from "@vercel/og";

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

function h(type, props, children) {
  const p = Object.assign({}, props || {});
  if (children !== undefined) p.children = children;
  return { type, props: p };
}

function arrayBufferToBase64(buf) {
  const bytes = new Uint8Array(buf);
  const chunk = 0x8000;
  let binary = "";
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

async function asDataUrl(url) {
  if (!url) return "";
  try {
    const r = await fetch(url);
    if (!r.ok) return "";
    const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0];
    if (ct.indexOf("image/") !== 0) return "";
    const buf = await r.arrayBuffer();
    if (buf.byteLength < 32 || buf.byteLength > 3500000) return "";
    return "data:" + ct + ";base64," + arrayBufferToBase64(buf);
  } catch (e) {
    return "";
  }
}

async function findLaunch(sym) {
  const want = String(sym || "").toUpperCase();
  if (!want) return null;
  const q =
    "query($t:String!){ events(first:50, filter:{ type:$t }){ nodes { timestamp contents { json } } } }";
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
        const ticker = String(p.symbol || "").toUpperCase();
        if (ticker === want) {
          return {
            symbol: ticker,
            name: p.name || ticker,
            token: typeNameOf(p.token),
            quote: quoteLabel(p.quote),
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

const PNG_HEADERS = {
  "content-type": "image/png",
  "cache-control": "public, s-maxage=600, stale-while-revalidate=86400",
};

function card(origin, { name, ticker, quote, pfp, bg }) {
  const kids = [];
  if (bg) {
    kids.push(
      h("img", {
        src: bg,
        width: 1200,
        height: 630,
        style: { position: "absolute", top: 0, left: 0, width: 1200, height: 630, objectFit: "cover" },
      })
    );
  }
  kids.push(
    h("div", {
      style: {
        position: "absolute",
        top: 0,
        left: 0,
        width: 1200,
        height: 630,
        display: "flex",
        background:
          "linear-gradient(90deg, rgba(18,8,20,.88) 0%, rgba(18,8,20,.62) 52%, rgba(18,8,20,.28) 100%)",
      },
    })
  );
  const row = [];
  if (pfp) {
    row.push(
      h("img", {
        src: pfp,
        width: 248,
        height: 248,
        style: {
          width: 248,
          height: 248,
          borderRadius: 36,
          objectFit: "cover",
          border: "4px solid #FF2EA6",
        },
      })
    );
  }
  row.push(
    h(
      "div",
      { style: { display: "flex", flexDirection: "column", justifyContent: "center", maxWidth: 760 } },
      [
        h("div", { style: { display: "flex", fontSize: 36, color: "#FF2EA6", fontWeight: 700, letterSpacing: 2 } }, "vice."),
        h("div", { style: { display: "flex", fontSize: ticker ? 64 : 72, color: "#F4EEF2", fontWeight: 700, lineHeight: 1.1, marginTop: 12 } }, name || "Vice"),
        ticker
          ? h("div", { style: { display: "flex", fontSize: 32, color: "#A898A8", marginTop: 14 } }, ticker + " / " + (quote || "SUI"))
          : h("div", { style: { display: "flex", fontSize: 28, color: "#A898A8", marginTop: 14 } }, "Straight to DEX launches on Sui"),
      ]
    )
  );
  kids.push(
    h(
      "div",
      {
        style: {
          position: "absolute",
          top: 0,
          left: 0,
          width: 1200,
          height: 630,
          display: "flex",
          alignItems: "center",
          padding: "0 72px",
          gap: 40,
        },
      },
      row
    )
  );
  return h(
    "div",
    {
      style: {
        width: "100%",
        height: "100%",
        display: "flex",
        position: "relative",
        background: "#120814",
        fontFamily: "sans-serif",
      },
    },
    kids
  );
}

async function png(request) {
  const origin = originOf(request);
  const t = new URL(request.url).searchParams.get("t") || "";
  const sym = String(t).trim().toUpperCase().slice(0, 12);
  const bgP = asDataUrl(origin + "/brand/og.jpg");
  if (!sym) {
    const bg = await bgP;
    return new ImageResponse(card(origin, { name: "Vice", pfp: "", bg, ticker: "", quote: "" }), {
      width: 1200,
      height: 630,
      headers: PNG_HEADERS,
    });
  }
  const launch = await findLaunch(sym);
  const iconUrl = launch ? await coinIcon(launch.token) : "";
  const [bg, pfp] = await Promise.all([bgP, asDataUrl(iconUrl)]);
  const name = (launch && launch.name) || sym;
  const quote = (launch && launch.quote) || "SUI";
  return new ImageResponse(card(origin, { name, ticker: sym, quote, pfp, bg }), {
    width: 1200,
    height: 630,
    headers: PNG_HEADERS,
  });
}

export async function GET(request) {
  try {
    return await png(request);
  } catch (e) {
    const origin = originOf(request);
    return Response.redirect(origin + "/brand/og.jpg", 302);
  }
}

export async function HEAD(request) {
  const res = await GET(request);
  return new Response(null, { status: res.status, headers: res.headers });
}
