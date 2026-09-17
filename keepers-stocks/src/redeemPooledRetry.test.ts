/**
 * Regression tests for the pooled (v2) redeem retry path.
 *
 * The bug: a pooled release records the sentinel depositId "v2". When the first
 * send failed, the record was left with consumedDepositIds ["v2"] and no
 * releasedDepositIds, so pendingDepositIds() was non-empty and the next pass
 * entered handleBurn's v1 retry shortcut — broadcastPending — which does
 * BigInt(attempt.depositId). BigInt("v2") throws a SyntaxError that the
 * surrounding try/catch swallows into a releaseError, so the burn retried
 * forever and could never settle. The wrapper was already destroyed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { suiBurnRef } from "./evmRelease.ts";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "redeem-pooled-"));
  process.env.STOCKS_DATA_DIR = dir;
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STOCKS_DATA_DIR;
});

const failedPooledRecord = () => ({
  key: "DIGEST:0",
  digest: "DIGEST",
  eventSeq: "0",
  ticker: "NVDA",
  amount: "370000000",
  burner: "0xburner",
  rhDest: "0x00000000000000000000000000000000000000aa",
  status: "error" as const,
  leftoverSui: "0",
  mismatch: "RH RPC HTTP 429",
  consumedDepositIds: ["v2"],
  releasedDepositIds: [] as string[],
  releases: [
    {
      depositId: "v2",
      to: "0x00000000000000000000000000000000000000aa",
      token: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
      rhAmount: "370000000000000000",
      suiAmount: "370000000",
      simulatedOk: true,
    },
  ],
  dryRun: false,
  at: new Date().toISOString(),
});

test("the failed pooled record is exactly the shape that fed BigInt()", async () => {
  const { pendingDepositIds } = await import("./redeemStore.ts");
  const rec = failedPooledRecord();

  // This is what put the record back into the retry loop.
  assert.deepEqual(pendingDepositIds(rec), ["v2"], "still pending after a failed send");

  // And this is what the v1 retry path then did with it.
  assert.throws(() => BigInt(rec.releases[0].depositId), {
    name: "SyntaxError",
  });
});

test("a pooled burn is never handed to the v1 retry path", async () => {
  // handleBurn must consult tryBackingOf and branch to the pooled handler
  // before it reaches the broadcastPending shortcut. Assert on source order,
  // since driving the whole watcher needs a live chain.
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./redeemWatcher.ts", import.meta.url), "utf8");

  const body = src.slice(src.indexOf("export async function handleBurn("));
  const pooledAt = body.indexOf("tryBackingOf(");
  const shortcutAt = body.indexOf("broadcastPending(");

  assert.ok(pooledAt > 0, "handleBurn checks tryBackingOf");
  assert.ok(shortcutAt > 0, "handleBurn still has the v1 shortcut");
  assert.ok(
    pooledAt < shortcutAt,
    "the pooled branch must come first, or a v2 record reaches BigInt() again",
  );
});

test("broadcastPending refuses a non-numeric depositId instead of throwing", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./redeemWatcher.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function broadcastPending("));
  const guardAt = fn.indexOf("/^\\d+$/.test(attempt.depositId)");
  const bigIntAt = fn.indexOf("BigInt(attempt.depositId)");

  assert.ok(guardAt > 0, "there is a numeric guard");
  assert.ok(guardAt < bigIntAt, "the guard runs before BigInt()");

  // And the guard's own predicate behaves.
  const numeric = (s: string) => /^\d+$/.test(s);
  assert.equal(numeric("v2"), false);
  assert.equal(numeric(""), false);
  assert.equal(numeric("3"), true);
  assert.equal(numeric("41827970112"), true);
});

test("an already-settled burn is recognised rather than resent forever", async () => {
  const { readFileSync } = await import("node:fs");
  const src = readFileSync(new URL("./redeemWatcher.ts", import.meta.url), "utf8");
  const fn = src.slice(src.indexOf("async function handleBurnPooled("));
  const settledAt = fn.indexOf("isSettled(");
  const sendAt = fn.indexOf("sendReleaseV2(");

  assert.ok(settledAt > 0, "handleBurnPooled asks the vault whether it already settled");
  assert.ok(settledAt < sendAt, "and asks before resending");
  assert.match(fn.slice(0, sendAt), /ALREADY_SETTLED/, "records the settled outcome");
});

test("suiBurnRef is stable across retries of the same burn", () => {
  // The retry must derive the same settlement key, or settledBurns cannot
  // deduplicate and the vault would pay twice.
  const a = suiBurnRef("DIGEST", "0");
  const b = suiBurnRef("DIGEST", "0");
  assert.equal(a, b);
  assert.notEqual(a, suiBurnRef("DIGEST", "1"));
});
