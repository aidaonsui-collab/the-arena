import assert from "node:assert/strict";
import { test } from "node:test";
import { parseBlockTag, safeCeiling, taggedBlockNumber } from "./rhWatcher.ts";

/**
 * Stand up a fake RH JSON-RPC so finality behaviour is testable without the
 * live chain. Returns a URL plus a mutable state object.
 */
async function fakeRpc(state: {
  latest: number;
  safe?: number | null;
  finalized?: number | null;
  serveTags?: boolean;
}) {
  const { createServer } = await import("node:http");
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { method, params } = JSON.parse(body);
      let result: unknown = null;
      if (method === "eth_blockNumber") {
        result = "0x" + state.latest.toString(16);
      } else if (method === "eth_getBlockByNumber") {
        const tag = params[0];
        if (tag === "latest") {
          result = { number: "0x" + state.latest.toString(16) };
        } else if (state.serveTags === false) {
          result = null; // node does not support the tag
        } else {
          const n = tag === "safe" ? state.safe : state.finalized;
          result = n == null ? null : { number: "0x" + n.toString(16) };
        }
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  const port = (server.address() as { port: number }).port;
  return { url: `http://127.0.0.1:${port}`, close: () => server.close() };
}

test("parseBlockTag accepts the three tags, defaults to safe, rejects junk", () => {
  assert.equal(parseBlockTag(undefined), "safe");
  assert.equal(parseBlockTag(""), "safe");
  assert.equal(parseBlockTag("latest"), "latest");
  assert.equal(parseBlockTag("SAFE"), "safe");
  assert.equal(parseBlockTag(" finalized "), "finalized");
  assert.throws(() => parseBlockTag("head"), /latest\|safe\|finalized/);
});

test("safe tag caps the scan far below the tip", async () => {
  const rpc = await fakeRpc({ latest: 1000, safe: 900, finalized: 800 });
  try {
    const got = await safeCeiling(rpc.url, "safe", 0);
    assert.equal(got.tip, 1000);
    assert.equal(got.tagBlock, 900);
    assert.equal(got.ceiling, 900, "never mints the 100 blocks above safe");
  } finally {
    rpc.close();
  }
});

test("finalized is stricter than safe", async () => {
  const rpc = await fakeRpc({ latest: 1000, safe: 900, finalized: 800 });
  try {
    const s = await safeCeiling(rpc.url, "safe", 0);
    const f = await safeCeiling(rpc.url, "finalized", 0);
    assert.ok(f.ceiling! < s.ceiling!, "finalized trails safe");
    assert.equal(f.ceiling, 800);
  } finally {
    rpc.close();
  }
});

test("confirmations subtract from the tag, not the tip", async () => {
  const rpc = await fakeRpc({ latest: 1000, safe: 900, finalized: 800 });
  try {
    const got = await safeCeiling(rpc.url, "safe", 50);
    assert.equal(got.ceiling, 850, "900 - 50, not 1000 - 50");
  } finally {
    rpc.close();
  }
});

test("latest with confirmations still holds back from the tip", async () => {
  const rpc = await fakeRpc({ latest: 1000, safe: 900, finalized: 800 });
  try {
    const got = await safeCeiling(rpc.url, "latest", 120);
    assert.equal(got.ceiling, 880);
    assert.equal(got.tagBlock, null, "no tag lookup for latest");
  } finally {
    rpc.close();
  }
});

test("a node that will not serve the tag falls back to a depth, never the tip", async () => {
  const rpc = await fakeRpc({ latest: 1000, serveTags: false });
  try {
    const got = await safeCeiling(rpc.url, "safe", 0);
    assert.equal(got.tagBlock, null);
    assert.ok(got.ceiling !== null && got.ceiling < got.tip, "must not degrade to tip");
    assert.equal(got.ceiling, 880, "falls back to the 120-block default depth");
  } finally {
    rpc.close();
  }
});

test("a deeper explicit confirmations wins over the fallback depth", async () => {
  const rpc = await fakeRpc({ latest: 1000, serveTags: false });
  try {
    const got = await safeCeiling(rpc.url, "safe", 500);
    assert.equal(got.ceiling, 500, "uses the larger of the two");
  } finally {
    rpc.close();
  }
});

test("a young chain with nothing final yet yields no ceiling", async () => {
  const rpc = await fakeRpc({ latest: 10, safe: 5 });
  try {
    const got = await safeCeiling(rpc.url, "safe", 100);
    assert.equal(got.ceiling, null, "negative ceiling is reported as nothing to scan");
  } finally {
    rpc.close();
  }
});

test("taggedBlockNumber returns null rather than throwing on an unsupported tag", async () => {
  const rpc = await fakeRpc({ latest: 1000, serveTags: false });
  try {
    assert.equal(await taggedBlockNumber(rpc.url, "finalized"), null);
  } finally {
    rpc.close();
  }
});

test("ceiling never exceeds the tip even if a node reports a tag ahead of it", async () => {
  const rpc = await fakeRpc({ latest: 900, safe: 1000 });
  try {
    const got = await safeCeiling(rpc.url, "safe", 0);
    assert.equal(got.ceiling, 900, "clamped to the tip");
  } finally {
    rpc.close();
  }
});
