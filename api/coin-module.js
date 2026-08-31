import { readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const tpl = require("@mysten/move-bytecode-template");
const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "coin-template.b64"), "utf8").trim();

const DEFAULTS = {
  decimals: 9,
  supply: "1000000000000000",
  symbol: "TMPL",
  name: "Template",
  description: "DESCRIPTION_PLACEHOLDER",
  icon: "ICON_PLACEHOLDER",
};

function bcsU8(n) {
  return Uint8Array.from([n & 0xff]);
}
function bcsU64(v) {
  let x = BigInt(v);
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) {
    out[i] = Number(x & 0xffn);
    x >>= 8n;
  }
  return out;
}
function uleb128(n) {
  const out = [];
  do {
    let b = n & 0x7f;
    n >>>= 7;
    if (n) b |= 0x80;
    out.push(b);
  } while (n);
  return out;
}
function bcsString(str) {
  const body = Buffer.from(String(str || ""), "utf8");
  return Buffer.concat([Buffer.from(uleb128(body.length)), body]);
}

function tickerToIdent(ticker) {
  let id = String(ticker || "").replace(/[^A-Za-z0-9_]/g, "").toLowerCase();
  if (!id) return "";
  if (/^[0-9]/.test(id)) id = "c" + id;
  return id.slice(0, 24);
}

function build(body) {
  const ident = tickerToIdent(body.ticker);
  if (!ident) throw new Error("Ticker needs at least one letter or digit");
  const upper = ident.toUpperCase();
  const decimals = body.decimals != null ? Number(body.decimals) : 9;
  const supply = String(body.supply || "1000000000000000000");
  let bytes = Buffer.from(TEMPLATE, "base64");
  bytes = tpl.update_identifiers(bytes, { TEMPLATE: upper, template: ident });
  bytes = tpl.update_constants(bytes, bcsU8(decimals), bcsU8(DEFAULTS.decimals), "U8");
  bytes = tpl.update_constants(bytes, bcsU64(supply), bcsU64(DEFAULTS.supply), "U64");
  bytes = tpl.update_constants(bytes, bcsString(body.symbol || upper), bcsString(DEFAULTS.symbol), "Vector(U8)");
  bytes = tpl.update_constants(bytes, bcsString(body.name || upper), bcsString(DEFAULTS.name), "Vector(U8)");
  bytes = tpl.update_constants(bytes, bcsString(body.description || ""), bcsString(DEFAULTS.description), "Vector(U8)");
  bytes = tpl.update_constants(bytes, bcsString(body.icon || ""), bcsString(DEFAULTS.icon), "Vector(U8)");
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8.length < 64 || u8[0] !== 0xa1 || u8[1] !== 0x1c || u8[2] !== 0xeb || u8[3] !== 0x0b) {
    throw new Error("Patched coin bytecode is not a valid Move module");
  }
  return {
    b64: Buffer.from(u8).toString("base64"),
    ident,
    upper,
    length: u8.length,
  };
}

export async function POST(req) {
  try {
    const body = await req.json();
    return Response.json(build(body || {}));
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
