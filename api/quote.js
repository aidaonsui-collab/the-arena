const SEVENK = "https://aggregator.api.sui-prod.bluefin.io/v2/quote";
const CETUS = "https://api-sui.cetus.zone/router_v3/find_routes";
const CETUS_V2 = "https://api-sui.cetus.zone/router_v2/find_routes";
const NAVI = "https://open-aggregator-api.naviprotocol.io/find_routes";

// Oracle-priced 7k sources need a Pyth key in buildTx. Leave them out.
const SEVENK_SOURCES = [
  "suiswap",
  "turbos",
  "cetus",
  "bluemove",
  "kriya",
  "kriya_v3",
  "aftermath",
  "deepbook_v3",
  "flowx",
  "flowx_v3",
  "bluefin",
  "springsui",
  "stsui",
  "steamm",
  "magma",
  "momentum",
  "fullsail",
  "cetus_dlmm",
  "ferra_dlmm",
  "ferra_clmm"
].join(",");

function asStr(v) {
  if (v == null) return "";
  if (typeof v === "bigint") return v.toString();
  return String(v);
}

function padType(t) {
  const parts = String(t || "").split("::");
  if (parts.length < 3) return String(t || "");
  let addr = parts[0].replace(/^0x/i, "").replace(/^0+/, "") || "0";
  parts[0] = "0x" + addr.padStart(64, "0");
  return parts.join("::");
}

function hopsFrom7k(j) {
  const swaps = (j && (j.swaps || j.routes)) || [];
  const names = [];
  function walk(x) {
    if (!x) return;
    if (Array.isArray(x)) return x.forEach(walk);
    const t = x.pool && (x.pool.type || x.pool.provider || x.pool.name);
    const p = x.provider || x.source || x.dex || t;
    if (p && names.indexOf(String(p)) < 0) names.push(String(p));
    if (x.hops) walk(x.hops);
    if (x.path) walk(x.path);
    if (x.swaps) walk(x.swaps);
  }
  walk(swaps);
  return names;
}

function hopsFromPaths(paths) {
  const names = [];
  (paths || []).forEach(function (p) {
    const hops = p.path || p.hops || p.pools || [];
    (Array.isArray(hops) ? hops : []).forEach(function (h) {
      const n = h.provider || h.dex || h.protocol || (h.info_for_ptb && h.info_for_ptb.moduleName);
      if (n && names.indexOf(String(n)) < 0) names.push(String(n));
    });
  });
  return names;
}

async function getJson(url, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(function () { ctrl.abort(); }, ms || 4500);
  try {
    const r = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: "application/json" },
      cache: "no-store"
    });
    const text = await r.text();
    let json = null;
    try { json = JSON.parse(text); } catch (e) {}
    return { ok: r.ok, status: r.status, json: json, text: text.slice(0, 400) };
  } finally {
    clearTimeout(t);
  }
}

function sevenkOk(j) {
  if (!j) return false;
  const out = j.returnAmountWithDecimal || j.returnAmount || j.amountOut;
  return out != null && String(out) !== "" && String(out) !== "0";
}

export async function GET(req) {
  const url = new URL(req.url);
  const amount = url.searchParams.get("amount") || "";
  const from = padType(url.searchParams.get("from") || "");
  const to = padType(url.searchParams.get("to") || "");
  const targetPools = url.searchParams.get("target_pools") || "";
  if (!amount || !from || !to) {
    return Response.json({ ok: false, error: "amount, from, to required" }, { status: 400 });
  }

  const errors = [];

  try {
    const q = new URLSearchParams({
      amount: amount,
      from: from,
      to: to,
      sources: SEVENK_SOURCES
    });
    if (targetPools) q.set("target_pools", targetPools);
    const r = await getJson(SEVENK + "?" + q.toString(), 4500);
    if (r.ok && sevenkOk(r.json)) {
      const j = r.json;
      return Response.json({
        ok: true,
        venue: "7k",
        amountIn: asStr(j.swapAmountWithDecimal || amount),
        amountOut: asStr(j.returnAmountWithDecimal || j.returnAmount),
        returnAmount: asStr(j.returnAmount || ""),
        hops: hopsFrom7k(j),
        raw: j
      });
    }
    errors.push("7k " + (r.status || "fail") + (r.text ? ": " + r.text : ""));
  } catch (e) {
    errors.push("7k " + ((e && e.message) || e));
  }

  try {
    const q = new URLSearchParams({
      from: from,
      target: to,
      amount: amount,
      by_amount_in: "true",
      depth: "3",
      version: "12"
    });
    const r = await getJson(NAVI + "?" + q.toString(), 4500);
    const d = r.json && (r.json.data || r.json);
    const out = d && (d.amount_out || d.amountOut);
    if (r.ok && out != null && String(out) !== "0") {
      return Response.json({
        ok: true,
        venue: "navi",
        amountIn: asStr((d && d.amount_in) || amount),
        amountOut: asStr(out),
        returnAmount: "",
        hops: hopsFromPaths((d && d.routes) || []),
        raw: r.json
      });
    }
    errors.push("navi " + (r.status || "fail"));
  } catch (e) {
    errors.push("navi " + ((e && e.message) || e));
  }

  try {
    const q = new URLSearchParams({
      from: from,
      target: to,
      amount: amount,
      by_amount_in: "true"
    });
    const r = await getJson(CETUS + "?" + q.toString(), 4500);
    const d = r.json && (r.json.data || r.json);
    const out = d && (d.amount_out || d.amountOut || d.outputAmount);
    if (r.ok && out != null && String(out) !== "0") {
      return Response.json({
        ok: true,
        venue: "cetus",
        amountIn: asStr((d && (d.amount_in || d.amountIn)) || amount),
        amountOut: asStr(out),
        returnAmount: "",
        hops: hopsFromPaths((d && (d.paths || d.routes || d.routers)) || []),
        raw: r.json
      });
    }
    errors.push("cetus " + ((r.json && r.json.msg) || r.status || "fail"));
  } catch (e) {
    errors.push("cetus " + ((e && e.message) || e));
  }

  try {
    const q = new URLSearchParams({
      from: from,
      target: to,
      amount: amount,
      by_amount_in: "true"
    });
    const r = await getJson(CETUS_V2 + "?" + q.toString(), 4500);
    const d = r.json && (r.json.data || r.json);
    const out = d && (d.amount_out || d.amountOut || d.outputAmount);
    if (r.ok && out != null && String(out) !== "0") {
      return Response.json({
        ok: true,
        venue: "cetus",
        amountIn: asStr((d && (d.amount_in || d.amountIn)) || amount),
        amountOut: asStr(out),
        returnAmount: "",
        hops: hopsFromPaths((d && (d.paths || d.routes || d.routers)) || []),
        raw: r.json
      });
    }
    errors.push("cetus-v2 " + (r.status || "fail"));
  } catch (e) {
    errors.push("cetus-v2 " + ((e && e.message) || e));
  }

  return Response.json({
    ok: false,
    error: "No aggregator route",
    detail: errors.slice(0, 3)
  }, { status: 404 });
}
