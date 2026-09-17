import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

let dir: string;
before(() => {
  dir = mkdtempSync(join(tmpdir(), "rh-watch-test-"));
  process.env.STOCKS_DATA_DIR = dir;
});
after(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.STOCKS_DATA_DIR;
});

const ev = (depositId: string) => ({
  txHash: "0xabc",
  blockNumber: 100,
  token: "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec",
  depositor: "0xdead",
  amount: "1000000000000000000",
  suiRecipient: "0x" + "11".repeat(32),
  depositId,
  ticker: "NVDA" as const,
  rhRef: `0xabc:${depositId}`,
});

test("cursor round-trips and survives a reload", async () => {
  const { saveFromBlock, savedFromBlock } = await import("./watchStore.ts");
  assert.equal(savedFromBlock(), null, "no cursor before the first run");
  saveFromBlock(65_000_000);
  assert.equal(savedFromBlock(), 65_000_000);
  saveFromBlock(65_000_123);
  assert.equal(savedFromBlock(), 65_000_123, "advances, does not reset to lookback");
});

test("a failed mint is parked, retried, and cleared on success", async () => {
  const { recordMintFailure, retryableMints, clearPendingMint } = await import("./watchStore.ts");
  const key = "0xabc:1";

  recordMintFailure(key, ev("1"), "RPC 503");
  let pending = retryableMints();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].attempts, 1);
  assert.equal(pending[0].lastError, "RPC 503");
  assert.equal(pending[0].event.rhRef, "0xabc:1");

  recordMintFailure(key, ev("1"), "RPC 503 again");
  pending = retryableMints();
  assert.equal(pending.length, 1, "same deposit, not a duplicate entry");
  assert.equal(pending[0].attempts, 2, "attempt count accumulates");
  assert.equal(pending[0].firstSeenAt, pending[0].firstSeenAt, "first-seen is preserved");

  clearPendingMint(key);
  assert.equal(retryableMints().length, 0, "cleared once minted");
});

test("retries stop after the cap and become a dead letter, never a silent drop", async () => {
  const { recordMintFailure, retryableMints, deadLetteredMints, MAX_MINT_ATTEMPTS, clearPendingMint } =
    await import("./watchStore.ts");
  const key = "0xabc:2";

  for (let i = 0; i < MAX_MINT_ATTEMPTS; i++) {
    recordMintFailure(key, ev("2"), `attempt ${i}`);
  }

  assert.equal(retryableMints().length, 0, "no longer retried automatically");
  const dead = deadLetteredMints();
  assert.equal(dead.length, 1, "still recorded, so an operator can find it");
  assert.equal(dead[0].attempts, MAX_MINT_ATTEMPTS);
  assert.equal(dead[0].event.depositId, "2");

  clearPendingMint(key);
});

test("independent deposits are tracked separately", async () => {
  const { recordMintFailure, retryableMints, clearPendingMint } = await import("./watchStore.ts");
  recordMintFailure("0xabc:10", ev("10"), "a");
  recordMintFailure("0xabc:11", ev("11"), "b");
  assert.equal(retryableMints().length, 2);

  clearPendingMint("0xabc:10");
  const left = retryableMints();
  assert.equal(left.length, 1);
  assert.equal(left[0].event.depositId, "11", "clearing one does not drop the other");
  clearPendingMint("0xabc:11");
});

test("a corrupt store reads as empty instead of throwing", async () => {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(join(dir, "rh-watch.json"), "{ not json");
  const { loadWatchStore } = await import("./watchStore.ts");
  const store = loadWatchStore();
  assert.equal(store.nextFromBlock, null);
  assert.deepEqual(store.pending, {});
});
