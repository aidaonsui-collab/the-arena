import assert from "node:assert/strict";
import { test } from "node:test";
import { matchFifo, rhAmountToSui, type RhLock } from "./matchFifo.ts";
import { parseRedeemBurned, parseVecU8, vecToAscii, vecToHex } from "./redeemEvent.ts";
import { RH_TO_SUI_SCALE } from "./config.ts";

const TOKEN = "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b";

function lock(id: number | bigint, amount: bigint, released = false): RhLock {
  return { depositId: BigInt(id), token: TOKEN, amount, released };
}

test("rhAmountToSui floors 18dp to 9dp", () => {
  assert.equal(rhAmountToSui(5n * 10n ** 18n), 5n * 10n ** 9n);
  assert.equal(rhAmountToSui(4947270614360234872n), 4947270614n);
  assert.equal(rhAmountToSui(RH_TO_SUI_SCALE - 1n), 0n);
});

test("exact single lock", () => {
  const r = matchFifo(10n * 10n ** 9n, [lock(1, 10n * 10n ** 18n)]);
  assert.equal(r.status, "exact");
  assert.equal(r.consumed.length, 1);
  assert.equal(r.consumed[0].depositId, "1");
  assert.equal(r.leftoverSui, "0");
  assert.equal(r.mismatch, null);
});

test("exact FIFO prefix of two locks", () => {
  const r = matchFifo(10n * 10n ** 9n, [
    lock(2, 6n * 10n ** 18n),
    lock(1, 4n * 10n ** 18n),
  ]);
  assert.equal(r.status, "exact");
  assert.deepEqual(r.consumed.map((c) => c.depositId), ["1", "2"]);
});

test("does not take a later lock when an earlier prefix already matches", () => {
  const r = matchFifo(10n * 10n ** 9n, [
    lock(1, 4n * 10n ** 18n),
    lock(2, 6n * 10n ** 18n),
    lock(3, 1n * 10n ** 18n),
  ]);
  assert.equal(r.status, "exact");
  assert.deepEqual(r.consumed.map((c) => c.depositId), ["1", "2"]);
});

test("oversize next lock is not taken — unmatched if nothing consumed", () => {
  const r = matchFifo(5n * 10n ** 9n, [lock(1, 10n * 10n ** 18n)]);
  assert.equal(r.status, "unmatched");
  assert.equal(r.consumed.length, 0);
  assert.equal(r.leftoverSui, (5n * 10n ** 9n).toString());
  assert.match(r.mismatch ?? "", /would over-release/);
});

test("oversize next lock after a fit is partial, not silent over-release", () => {
  const r = matchFifo(10n * 10n ** 9n, [
    lock(1, 4n * 10n ** 18n),
    lock(2, 7n * 10n ** 18n),
  ]);
  assert.equal(r.status, "partial");
  assert.deepEqual(r.consumed.map((c) => c.depositId), ["1"]);
  assert.equal(r.leftoverSui, (6n * 10n ** 9n).toString());
  assert.match(r.mismatch ?? "", /depositId=2/);
});

test("released locks are ignored", () => {
  const r = matchFifo(10n * 10n ** 9n, [
    lock(1, 10n * 10n ** 18n, true),
    lock(2, 10n * 10n ** 18n),
  ]);
  assert.equal(r.status, "exact");
  assert.deepEqual(r.consumed.map((c) => c.depositId), ["2"]);
});

test("no locks → unmatched", () => {
  const r = matchFifo(1n, []);
  assert.equal(r.status, "unmatched");
  assert.match(r.mismatch ?? "", /no unreleased locks/);
});

test("zero burn → unmatched", () => {
  const r = matchFifo(0n, [lock(1, 1n * 10n ** 18n)]);
  assert.equal(r.status, "unmatched");
  assert.match(r.mismatch ?? "", /must be > 0/);
});

test("dust-only lock is skipped, not consumed", () => {
  const r = matchFifo(1n * 10n ** 9n, [
    lock(1, RH_TO_SUI_SCALE - 1n),
    lock(2, 1n * 10n ** 18n),
  ]);
  assert.equal(r.status, "exact");
  assert.deepEqual(r.consumed.map((c) => c.depositId), ["2"]);
  assert.deepEqual(r.skippedDustIds, ["1"]);
});

test("under-collateralized after consuming whole locks is partial", () => {
  const r = matchFifo(10n * 10n ** 9n, [lock(1, 4n * 10n ** 18n), lock(2, 4n * 10n ** 18n)]);
  assert.equal(r.status, "partial");
  assert.equal(r.consumed.length, 2);
  assert.equal(r.leftoverSui, (2n * 10n ** 9n).toString());
  assert.match(r.mismatch ?? "", /leftover/);
});

test("real AMC round-trip units match floor(rh/1e9)", () => {
  const rh = 4947270614360234872n;
  const sui = rhAmountToSui(rh);
  const r = matchFifo(sui, [lock(1, rh)]);
  assert.equal(r.status, "exact");
  assert.equal(r.consumed[0].rhAmount, rh.toString());
});

test("parseVecU8: number array, hex, utf8 ticker, base64 QU1D=AMC", () => {
  assert.equal(vecToAscii(parseVecU8([65, 77, 67])), "AMC");
  assert.equal(vecToAscii(parseVecU8("0x414d43")), "AMC");
  assert.equal(vecToAscii(parseVecU8("AMC")), "AMC");
  assert.equal(vecToAscii(parseVecU8("QU1D")), "AMC");
  const dest = parseVecU8("0xde0d5aea396d5b937149e36ddbfd6b49f26f19bc");
  assert.equal(dest.length, 20);
  assert.equal(vecToHex(dest), "0xde0d5aea396d5b937149e36ddbfd6b49f26f19bc");
});

test("parseRedeemBurned requires 20-byte rh_dest and known ticker", () => {
  const ev = {
    id: { txDigest: "AbC", eventSeq: "0" },
    parsedJson: {
      ticker: [65, 77, 67],
      amount: "4947270614",
      burner: "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b",
      rh_dest: Array.from(parseVecU8("0xde0d5aea396d5b937149e36ddbfd6b49f26f19bc")),
    },
  };
  const parsed = parseRedeemBurned(ev);
  assert.ok(parsed);
  assert.equal(parsed!.ticker, "AMC");
  assert.equal(parsed!.key, "AbC:0");
  assert.equal(parsed!.rhDest, "0xde0d5aea396d5b937149e36ddbfd6b49f26f19bc");
  assert.equal(parsed!.amount, 4947270614n);

  assert.equal(
    parseRedeemBurned({
      id: ev.id,
      parsedJson: { ...ev.parsedJson, rh_dest: [1, 2, 3] },
    }),
    null,
  );
  assert.equal(
    parseRedeemBurned({
      id: ev.id,
      parsedJson: { ...ev.parsedJson, ticker: [88, 88] },
    }),
    null,
  );
});
