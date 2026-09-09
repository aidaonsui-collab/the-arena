import assert from "node:assert/strict";
import { test } from "node:test";
import {
  decodeGetLock,
  encodeGetLockCalldata,
  encodeReleaseCalldata,
} from "./rhRpc.ts";

test("release(uint256,address) calldata matches cast", () => {
  const got = encodeReleaseCalldata(1n, "0xDE0d5aea396D5b937149E36ddBfd6b49f26f19bc");
  assert.equal(
    got,
    "0x8124fea60000000000000000000000000000000000000000000000000000000000000001000000000000000000000000de0d5aea396d5b937149e36ddbfd6b49f26f19bc",
  );
});

test("getLock(uint256) calldata matches cast", () => {
  assert.equal(
    encodeGetLockCalldata(1n),
    "0xd68f4dd10000000000000000000000000000000000000000000000000000000000000001",
  );
});

test("decodeGetLock reads depositor/token/amount/released", () => {
  const depositor = "de0d5aea396d5b937149e36ddbfd6b49f26f19bc";
  const token = "05a3d1cd21d0c88145e82600e62e7e496e0f222b";
  const amount = 4947270614360234872n.toString(16).padStart(64, "0");
  const sui = "92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";
  const data =
    "0x" +
    depositor.padStart(64, "0") +
    token.padStart(64, "0") +
    amount +
    sui +
    "0".repeat(63) +
    "1";
  const lock = decodeGetLock(1n, data);
  assert.ok(lock);
  assert.equal(lock!.depositor, "0xde0d5aea396d5b937149e36ddbfd6b49f26f19bc");
  assert.equal(lock!.token, "0x05a3d1cd21d0c88145e82600e62e7e496e0f222b");
  assert.equal(lock!.amount, 4947270614360234872n);
  assert.equal(lock!.released, true);
  assert.equal(decodeGetLock(1n, "0x" + "0".repeat(320)), null);
});
