import assert from "node:assert/strict";
import { test } from "node:test";
import {
  checkReceipt,
  parseVerifyRpcs,
  verifyDeposit,
  type DepositClaim,
  type Receipt,
} from "./verifyDeposit.ts";
import { decodeDepositLocked, DEPOSIT_LOCKED_TOPIC0 } from "./rhWatcher.ts";

const VAULT = "0xB0DbeAa279A4D1c5BBB67f7083a3C5445Af3c058";
const EVIL = "0x000000000000000000000000000000000000dead";
const TOKEN = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";

const topics = [
  DEPOSIT_LOCKED_TOPIC0,
  "0x000000000000000000000000" + TOKEN.slice(2).toLowerCase(),
  "0x000000000000000000000000" + EVIL.slice(2).toLowerCase(),
  "0x" + (5).toString(16).padStart(64, "0"),
];
const data = "0x" + (10n ** 18n).toString(16).padStart(64, "0") + "11".repeat(32);

const claim: DepositClaim = {
  txHash: "0xfeed",
  blockNumber: 100,
  logIndex: 7,
  topics,
  data,
};

const goodReceipt = (): Receipt => ({
  status: "0x1",
  blockNumber: "0x64", // 100
  logs: [
    { address: "0xsomethingelse", topics: [], data: "0x", logIndex: "0x6" },
    { address: VAULT, topics, data, logIndex: "0x7" },
  ],
});

// --- decoder rejects logs the node should never have returned -------------

test("decodeDepositLocked rejects a log emitted by anything but the vault", () => {
  const log = {
    address: EVIL, // node ignored the address filter, or is lying
    topics,
    data,
    transactionHash: "0xfeed",
    blockNumber: "0x64",
    logIndex: "0x7",
  };
  assert.equal(decodeDepositLocked(log, VAULT), null, "forged emitter is dropped");
  assert.ok(decodeDepositLocked({ ...log, address: VAULT }, VAULT), "real emitter decodes");
});

test("decodeDepositLocked keeps logIndex and raw fields for later re-checking", () => {
  const ev = decodeDepositLocked(
    { address: VAULT, topics, data, transactionHash: "0xfeed", blockNumber: "0x64", logIndex: "0x7" },
    VAULT,
  );
  assert.ok(ev);
  assert.equal(ev.logIndex, 7);
  assert.deepEqual(ev.rawTopics, topics.map((t) => t.toLowerCase()));
  assert.equal(ev.rawData, data.toLowerCase());
  assert.equal(ev.depositId, "5");
});

// --- receipt check ---------------------------------------------------------

test("a matching receipt verifies", () => {
  const r = checkReceipt(goodReceipt(), VAULT, claim);
  assert.equal(r.ok, true);
});

test("a missing receipt is retryable, not fatal", () => {
  const r = checkReceipt(null, VAULT, claim);
  assert.equal(r.ok, false);
  assert.equal(r.fatal, false, "an unsynced node must not condemn a real deposit");
});

test("a reverted transaction is fatal", () => {
  const r = checkReceipt({ ...goodReceipt(), status: "0x0" }, VAULT, claim);
  assert.equal(r.ok, false);
  assert.equal(r.fatal, true);
  assert.match(r.reason!, /did not succeed/);
});

test("a log at the claimed index but from another contract is fatal", () => {
  const rcpt = goodReceipt();
  rcpt.logs![1].address = EVIL;
  const r = checkReceipt(rcpt, VAULT, claim);
  assert.equal(r.fatal, true);
  assert.match(r.reason!, /not the vault/);
});

test("tampered topics or data are fatal", () => {
  const t = goodReceipt();
  t.logs![1].topics = [...topics.slice(0, 3), "0x" + (999).toString(16).padStart(64, "0")];
  assert.equal(checkReceipt(t, VAULT, claim).fatal, true, "depositId swapped");

  const d = goodReceipt();
  d.logs![1].data = "0x" + (10n ** 24n).toString(16).padStart(64, "0") + "11".repeat(32);
  const r = checkReceipt(d, VAULT, claim);
  assert.equal(r.fatal, true, "amount inflated");
  assert.match(r.reason!, /data does not match/);
});

test("a log that is not in the receipt at all is fatal", () => {
  const rcpt = goodReceipt();
  rcpt.logs = [rcpt.logs![0]];
  const r = checkReceipt(rcpt, VAULT, claim);
  assert.equal(r.fatal, true);
  assert.match(r.reason!, /no log at logIndex/);
});

test("a receipt from a different block is fatal", () => {
  const r = checkReceipt({ ...goodReceipt(), blockNumber: "0x65" }, VAULT, claim);
  assert.equal(r.fatal, true);
  assert.match(r.reason!, /block mismatch/);
});

// --- multi-source quorum ---------------------------------------------------

async function fakeNode(receipt: Receipt | null | "error") {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (receipt === "error") {
        res.writeHead(500);
        res.end("boom");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: receipt }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("primary plus an independent confirmation verifies", async () => {
  const a = await fakeNode(goodReceipt());
  const b = await fakeNode(goodReceipt());
  try {
    const out = await verifyDeposit({ primaryRpc: a.url, verifyRpcs: [b.url] }, VAULT, claim);
    assert.equal(out.ok, true);
    assert.equal(out.confirmedBy.length, 2);
  } finally {
    a.close();
    b.close();
  }
});

test("a lying primary is caught by the independent source and is fatal", async () => {
  // Primary serves a receipt whose log is from an attacker contract; the honest
  // node has no such log at all.
  const lying = goodReceipt();
  lying.logs![1].address = EVIL;
  const a = await fakeNode(lying);
  const b = await fakeNode(goodReceipt());
  try {
    const out = await verifyDeposit({ primaryRpc: a.url, verifyRpcs: [b.url] }, VAULT, claim);
    assert.equal(out.ok, false);
    assert.equal(out.fatal, true, "disagreement must stop the mint, not retry it");
    assert.match(out.reason!, /not the vault/);
  } finally {
    a.close();
    b.close();
  }
});

test("an honest primary plus a lying verifier is still fatal", async () => {
  const lying = goodReceipt();
  lying.logs![1].data = "0x" + (10n ** 24n).toString(16).padStart(64, "0") + "11".repeat(32);
  const a = await fakeNode(goodReceipt());
  const b = await fakeNode(lying);
  try {
    const out = await verifyDeposit({ primaryRpc: a.url, verifyRpcs: [b.url] }, VAULT, claim);
    assert.equal(out.fatal, true, "any disagreement means one of them is wrong");
  } finally {
    a.close();
    b.close();
  }
});

test("an unreachable verifier withholds the mint without condemning it", async () => {
  const a = await fakeNode(goodReceipt());
  const b = await fakeNode("error");
  try {
    const out = await verifyDeposit({ primaryRpc: a.url, verifyRpcs: [b.url] }, VAULT, claim);
    assert.equal(out.ok, false);
    assert.equal(out.fatal, false, "retryable — the node is down, not lying");
    assert.match(out.reason!, /0\/1 independent/);
  } finally {
    a.close();
    b.close();
  }
});

test("quorum below the configured verifier count is honoured", async () => {
  const a = await fakeNode(goodReceipt());
  const b = await fakeNode(goodReceipt());
  const c = await fakeNode("error");
  try {
    const out = await verifyDeposit(
      { primaryRpc: a.url, verifyRpcs: [b.url, c.url], quorum: 1 },
      VAULT,
      claim,
    );
    assert.equal(out.ok, true, "one good independent confirmation is enough at quorum 1");
  } finally {
    a.close();
    b.close();
    c.close();
  }
});

test("with no verifiers configured the receipt check alone still gates", async () => {
  const bad = goodReceipt();
  bad.status = "0x0";
  const a = await fakeNode(bad);
  try {
    const out = await verifyDeposit({ primaryRpc: a.url }, VAULT, claim);
    assert.equal(out.ok, false);
    assert.equal(out.fatal, true, "reverted tx is caught even single-sourced");
  } finally {
    a.close();
  }
});

test("parseVerifyRpcs splits on commas and whitespace and drops blanks", () => {
  assert.deepEqual(parseVerifyRpcs("https://a , https://b"), ["https://a", "https://b"]);
  assert.deepEqual(parseVerifyRpcs("https://a\nhttps://b"), ["https://a", "https://b"]);
  assert.deepEqual(parseVerifyRpcs(""), []);
  assert.deepEqual(parseVerifyRpcs(undefined), []);
});
