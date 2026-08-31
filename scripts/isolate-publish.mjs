/**
 * Isolate which coin-template patch makes Publish fail VM verification.
 * Dry-runs against mainnet after each step. Never submits.
 *
 *   node scripts/isolate-publish.mjs
 *   node scripts/isolate-publish.mjs 0xSENDER
 *
 * Sui rejects a module whose Vector(U8) constant-pool values are not unique
 * (VMVerificationOrDeserializationError in command 0). Create often reuses
 * the same string for name, ticker, and description — that is the live bug.
 */
import { createRequire } from "module";
import { Transaction } from "@mysten/sui/transactions";
import { SuiClient } from "@mysten/sui/client";
import { build } from "../api/coin-module.js";

const require = createRequire(import.meta.url);
const tpl = require("@mysten/move-bytecode-template");
const SENDER = process.argv[2] || "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";
const RPCS = [
  "https://mainnet.suiet.app",
  "https://rpc-mainnet.suiscan.xyz:443",
  "https://sui-mainnet-endpoint.blockvision.org",
];

async function firstClient() {
  let last;
  for (const url of RPCS) {
    try {
      const client = new SuiClient({ url });
      await client.getLatestCheckpointSequenceNumber();
      console.log("rpc", url);
      return client;
    } catch (e) {
      last = e;
      console.log("rpc fail", url, e.message || e);
    }
  }
  throw last;
}

async function dryPublish(client, b64, label) {
  const t = new Transaction();
  t.setSender(SENDER);
  const cap = t.publish({ modules: [b64], dependencies: ["0x1", "0x2"] });
  t.transferObjects([cap], SENDER);
  try {
    const dry = await client.dryRunTransactionBlock({
      transactionBlock: await t.build({ client }),
    });
    const st = dry.effects?.status;
    const ok = st?.status === "success";
    console.log((ok ? "OK  " : "FAIL") + " " + label + " → " + (ok ? "success" : (st?.error || JSON.stringify(st) || "").slice(0, 120)));
    return ok;
  } catch (e) {
    const msg = e.message || String(e);
    console.log("EXC  " + label + " → " + msg.slice(0, 160));
    return false;
  }
}

function showConsts(b64, label) {
  const bytes = Buffer.from(b64, "base64");
  const cs = tpl.get_constants(bytes);
  console.log("  constants " + label);
  cs.forEach((c, i) => {
    const v = Buffer.from(c.value_bcs);
    if (c.type_ === "Vector(U8)") {
      let n = 0, k = 0, sh = 0;
      while (k < v.length) {
        const b = v[k++];
        n |= (b & 0x7f) << sh;
        if (!(b & 0x80)) break;
        sh += 7;
      }
      console.log("   ", i, JSON.stringify(v.subarray(k, k + n).toString("utf8")));
    } else if (c.type_ === "U64") {
      let x = 0n;
      for (let k = 7; k >= 0; k--) x = (x << 8n) + BigInt(v[k]);
      console.log("   ", i, "u64", x.toString());
    } else {
      console.log("   ", i, c.type_, [...v]);
    }
  });
}

const client = await firstClient();
const blob = "https://7x8k9.public.blob.vercel-storage.com/silver-cat.png";
const cases = [
  {
    id: "SILVER name=desc, no art  (the live Create payload)",
    body: {
      ticker: "SILVER",
      symbol: "SILVER",
      name: "Silver Cat",
      decimals: 9,
      supply: "1000000000000000000",
      description: "Silver Cat",
      icon: "",
    },
  },
  {
    id: "SILVER name=desc + blob icon",
    body: {
      ticker: "SILVER",
      symbol: "SILVER",
      name: "Silver Cat",
      decimals: 9,
      supply: "1000000000000000000",
      description: "Silver Cat",
      icon: blob,
    },
  },
  {
    id: "LOOK name=ticker=desc, no art",
    body: {
      ticker: "LOOK",
      symbol: "LOOK",
      name: "LOOK",
      decimals: 9,
      supply: "1000000000000000000",
      description: "LOOK",
      icon: "",
    },
  },
  {
    id: "1-char ticker, empty desc, no art",
    body: {
      ticker: "A",
      symbol: "A",
      name: "A",
      decimals: 9,
      supply: "1000000000000000000",
      description: "",
      icon: "",
    },
  },
];

let failed = 0;
for (const c of cases) {
  console.log("\n== " + c.id + " ==");
  const mod = build(c.body);
  showConsts(mod.b64, c.id);
  const ok = await dryPublish(client, mod.b64, c.id + " len=" + mod.length);
  if (!ok) failed++;
}

if (failed) {
  console.log("\n" + failed + " case(s) failed");
  process.exit(1);
}
console.log("\nall dry-runs succeeded");
