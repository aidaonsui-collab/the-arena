/**
 * Checks the zero-supply basket coin template and the seed PTB shape.
 * Does not publish or submit.
 *
 *   node scripts/basket-coin-build.mjs
 */
import { readFileSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { Transaction } from "@mysten/sui/transactions";
import { build, TEMPLATE } from "../api/basket-coin-module.js";
import { appendBasketSeed } from "../js/basket-seed.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const raw = Buffer.from(readFileSync(join(root, "api/basket-coin-template.b64"), "utf8").trim(), "base64");
const memeSupply = Buffer.from("0080c6a47e8d0300", "hex");
if (raw.includes(memeSupply)) {
  throw new Error("basket template still contains the meme coin TOTAL_SUPPLY constant");
}
if (!raw.includes(Buffer.from("template")) || raw.includes(Buffer.from("mint"))) {
  throw new Error("template bytecode should name template and should not name mint");
}

const mod = build({
  ticker: "goldbag",
  symbol: "GOLDBAG",
  name: "Gold Bag",
  description: "share",
  decimals: 9,
});
const patched = Buffer.from(mod.b64, "base64");
if (mod.ident !== "goldbag" || mod.upper !== "GOLDBAG") throw new Error("ident");
if (!patched.includes(Buffer.from("goldbag")) || !patched.includes(Buffer.from("GOLDBAG"))) {
  throw new Error("identifiers were not patched");
}
if (patched.includes(Buffer.from("template"))) throw new Error("template ident left in patched module");
if (TEMPLATE.length < 100) throw new Error("template missing");

const sender = "0x" + "11".repeat(32);
const pkg = "0x" + "ab".repeat(32);
const tx = new Transaction();
tx.setSender(sender);
const sui = tx.splitCoins(tx.gas, [tx.pure.u64(2_000)]);
const other = tx.splitCoins(tx.object("0x" + "22".repeat(32)), [tx.pure.u64(5_000)]);
appendBasketSeed(tx, {
  packageId: pkg,
  basketType: "0x" + "33".repeat(32) + "::goldbag::GOLDBAG",
  treasuryId: "0x" + "44".repeat(32),
  seedShares: 1000n,
  depositCap: 1_000_000n,
  legs: [
    { type: "0x2::sui::SUI", units: 2n, coin: Array.isArray(sui) ? sui[0] : sui },
    { type: "0x" + "55".repeat(32) + "::tcoin::TCOIN", units: 5n, coin: Array.isArray(other) ? other[0] : other },
  ],
});
const rawJson = await tx.toJSON();
const json = typeof rawJson === "string" ? rawJson : JSON.stringify(rawJson);
const calls = [
  ["type_name", "with_defining_ids"],
  ["basket", "new_leg"],
  ["basket", "create"],
  ["basket", "deposit"],
  ["basket", "finish_seed"],
  ["coin", "destroy_zero"],
];
for (const [modName, fn] of calls) {
  if (!json.includes(`"module": "${modName}"`) || !json.includes(`"function": "${fn}"`)) {
    throw new Error("seed tx missing " + modName + "::" + fn);
  }
}
if ((json.match(/"function": "deposit"/g) || []).length !== 2) throw new Error("expected one deposit per leg");
if (!json.includes('"function": "destroy_zero"')) throw new Error("exact seed should destroy zero surplus");

const zap = new Transaction();
zap.setSender(sender);
const zapSui = zap.splitCoins(zap.gas, [zap.pure.u64(2_000)]);
const zapOther = zap.splitCoins(zap.gas, [zap.pure.u64(9_000)]);
appendBasketSeed(zap, {
  packageId: pkg,
  basketType: "0x" + "33".repeat(32) + "::goldbag::GOLDBAG",
  treasuryId: "0x" + "44".repeat(32),
  seedShares: 1000n,
  depositCap: 1_000_000n,
  sender,
  legs: [
    { type: "0x2::sui::SUI", units: 2n, coin: Array.isArray(zapSui) ? zapSui[0] : zapSui },
    { type: "0x" + "55".repeat(32) + "::tcoin::TCOIN", units: 5n, coin: Array.isArray(zapOther) ? zapOther[0] : zapOther },
  ],
});
const zapRaw = await zap.toJSON();
const zapJson = typeof zapRaw === "string" ? zapRaw : JSON.stringify(zapRaw);
if (zapJson.includes('"function": "destroy_zero"')) throw new Error("swap seed must return surplus");
if (!zapJson.includes("TransferObjects")) throw new Error("swap seed missing surplus transfer");
console.log("basket coin + seed tx ok", mod.length);
