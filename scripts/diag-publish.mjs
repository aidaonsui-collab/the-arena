/**
 * Diagnose Create coin-publish PTB the same way the live page does.
 * Run: node scripts/diag-publish.mjs
 */
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { build } from "../api/coin-module.js";

const SENDER = process.argv[2] || "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";
const RPCS = [
  "https://mainnet.suiet.app",
  "https://rpc-mainnet.suiscan.xyz:443",
  "https://sui-mainnet-endpoint.blockvision.org",
];

function step(title) {
  console.log("\n== " + title + " ==");
}
function buildModule() {
  const built = build({
    ticker: "SILVER",
    symbol: "SILVER",
    name: "Silver Cat",
    decimals: 9,
    supply: "1000000000000000000",
    description: "Silver Cat",
    icon: "",
  });
  const u8 = Buffer.from(built.b64, "base64");
  return { u8, b64: built.b64, ident: built.ident, upper: built.upper };
}

async function rpc(url, method, params) {
  const r = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const j = await r.json();
  if (j.error) throw new Error(url + " " + method + ": " + (j.error.message || JSON.stringify(j.error)));
  return j.result;
}

async function firstClient() {
  let last;
  for (const url of RPCS) {
    try {
      const client = new SuiClient({ url });
      await client.getLatestCheckpointSequenceNumber();
      console.log("rpc ok", url);
      return { client, url };
    } catch (e) {
      last = e;
      console.log("rpc fail", url, e.message || e);
    }
  }
  throw last;
}

function inspectJson(txJson) {
  const j = typeof txJson === "string" ? JSON.parse(txJson) : txJson;
  console.log("txJson keys", Object.keys(j));
  const cmds = j.commands || j.transaction?.commands || j.ptb?.commands || [];
  console.log("commands", cmds.length);
  cmds.forEach((c, i) => {
    const k = Object.keys(c)[0];
    let extra = "";
    if (k === "Publish" || c.Publish) {
      const p = c.Publish || c.publish || c;
      const mods = p.modules || p[0] || [];
      extra = " modules=" + (Array.isArray(mods) ? mods.length : typeof mods);
      if (Array.isArray(mods) && mods[0]) {
        extra += " mod0type=" + typeof mods[0] + " mod0len=" + (mods[0].length || 0);
        if (typeof mods[0] === "string") extra += " prefix=" + mods[0].slice(0, 12);
      }
    }
    console.log("  cmd" + i, k || JSON.stringify(c).slice(0, 80), extra);
  });
  return j;
}

const mod = buildModule();
step("1. coin module");
console.log("len", mod.u8.length);
console.log("magic", Buffer.from(mod.u8.subarray(0, 4)).toString("hex"), mod.u8[0] === 0xa1 ? "OK" : "BAD");
console.log("b64 len", mod.b64.length);

step("2. Transaction.toJSON (no build)");
const tx = new Transaction();
tx.setSender(SENDER);
const cap = tx.publish({ modules: [mod.b64], dependencies: ["0x1", "0x2"] });
tx.transferObjects([cap], SENDER);
let txJson = await tx.toJSON();
if (typeof txJson !== "string") txJson = JSON.stringify(txJson);
inspectJson(txJson);

step("3. Transaction.from round-trip");
try {
  const tx2 = Transaction.from(txJson);
  const j2 = await tx2.toJSON();
  console.log("from() ok, json type", typeof j2, "len", String(j2).length);
} catch (e) {
  console.log("from() FAIL", e.message || e);
}

const { client, url } = await firstClient();
step("4. dry-run simple split (control)");
try {
  const t = new Transaction();
  t.setSender(SENDER);
  t.splitCoins(t.gas, [1]);
  const dry = await client.dryRunTransactionBlock({ transactionBlock: await t.build({ client }) });
  console.log("simple split", dry.effects?.status);
} catch (e) {
  console.log("simple split FAIL", e.message || e);
}

step("5. dry-run publish (b64 modules, no gas budget)");
try {
  const t = new Transaction();
  t.setSender(SENDER);
  const c = t.publish({ modules: [mod.b64], dependencies: ["0x1", "0x2"] });
  t.transferObjects([c], SENDER);
  const bytes = await t.build({ client });
  console.log("built bytes", bytes.length || bytes.byteLength);
  const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  console.log("status", dry.effects?.status);
  if (dry.effects?.status?.error) console.log("error", dry.effects.status.error);
} catch (e) {
  console.log("publish dry-run FAIL", e.message || e);
  if (e.stack) console.log(e.stack.split("\n").slice(0, 8).join("\n"));
}

step("6. dry-run publish from server JSON");
try {
  const t = Transaction.from(txJson);
  const bytes = await t.build({ client });
  const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  console.log("status", dry.effects?.status);
  if (dry.effects?.status?.error) console.log("error", dry.effects.status.error);
} catch (e) {
  console.log("json publish dry-run FAIL", e.message || e);
}

step("7. dry-run publish with number[] modules");
try {
  const t = new Transaction();
  t.setSender(SENDER);
  const c = t.publish({ modules: [Array.from(mod.u8)], dependencies: ["0x1", "0x2"] });
  t.transferObjects([c], SENDER);
  const dry = await client.dryRunTransactionBlock({ transactionBlock: await t.build({ client }) });
  console.log("status", dry.effects?.status);
  if (dry.effects?.status?.error) console.log("error", dry.effects.status.error);
} catch (e) {
  console.log("u8[] publish FAIL", e.message || e);
}

step("8. rpc dryRun of built b64 tx");
try {
  const t = new Transaction();
  t.setSender(SENDER);
  const c = t.publish({ modules: [mod.b64], dependencies: ["0x1", "0x2"] });
  t.transferObjects([c], SENDER);
  const bytes = await t.build({ client });
  const b64 = Buffer.from(bytes).toString("base64");
  const dry = await rpc(url, "sui_dryRunTransactionBlock", [b64]);
  console.log("rpc status", dry.effects?.status || dry);
} catch (e) {
  console.log("rpc dryRun FAIL", e.message || e);
}

console.log("\ndone");
