import { readFileSync } from "fs";
import { createRequire } from "module";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Transaction } from "@mysten/sui/transactions";

const require = createRequire(import.meta.url);
const tpl = require("@mysten/move-bytecode-template");
const TEMPLATE = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "coin-template.b64"), "utf8").trim();

const DEFAULTS = {
  decimals: 9,
  supply: "1000000000000000",
  symbol: "S",
  name: "N",
  description: "",
  icon: "-",
};

// Sui rejects a published module whose Vector(U8) constant-pool entries
// are not unique (VMVerificationOrDeserializationError in command 0).
// Create often uses the same string for name and description, or name and
// ticker; a trailing U+200B is invisible in wallets and keeps the pool unique.
function uniquifyVecs(symbol, name, description, icon) {
  const used = new Set();
  function take(s, zwsp) {
    let v = String(s ?? "");
    while (used.has(v)) v += zwsp ? "\u200b" : " ";
    used.add(v);
    return v;
  }
  const out = {
    symbol: take(symbol, false),
    name: take(name, true),
    description: take(description, true),
  };
  let ic = String(icon || "");
  if (!ic) ic = DEFAULTS.icon;
  while (used.has(ic)) ic += ic.startsWith("http") ? "#" : "\u0001";
  used.add(ic);
  out.icon = ic;
  return out;
}

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
  const vecs = uniquifyVecs(body.symbol || upper, body.name || upper, body.description || "", body.icon || "");
  let bytes = Buffer.from(TEMPLATE, "base64");
  bytes = tpl.update_identifiers(bytes, { TEMPLATE: upper, template: ident });
  bytes = tpl.update_constants(bytes, bcsU8(decimals), bcsU8(DEFAULTS.decimals), "U8");
  bytes = tpl.update_constants(bytes, bcsU64(supply), bcsU64(DEFAULTS.supply), "U64");
  bytes = tpl.update_constants(bytes, bcsString(vecs.symbol), bcsString(DEFAULTS.symbol), "Vector(U8)");
  bytes = tpl.update_constants(bytes, bcsString(vecs.name), bcsString(DEFAULTS.name), "Vector(U8)");
  bytes = tpl.update_constants(bytes, bcsString(vecs.description), bcsString(DEFAULTS.description), "Vector(U8)");
  bytes = tpl.update_constants(bytes, bcsString(vecs.icon), bcsString(DEFAULTS.icon), "Vector(U8)");
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

export { build, uniquifyVecs, DEFAULTS };

export async function POST(req) {
  try {
    const body = await req.json();
    const mod = build(body || {});
    let txJson = null;
    const sender = String(body.sender || "");
    if (sender) {
      const tx = new Transaction();
      tx.setSender(sender);
      const cap = tx.publish({
        modules: [mod.b64],
        dependencies: ["0x1", "0x2"],
      });
      tx.transferObjects([cap], sender);
      txJson = await tx.toJSON();
      if (typeof txJson !== "string") txJson = JSON.stringify(txJson);
    }
    return Response.json({ ...mod, txJson });
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 400 });
  }
}
