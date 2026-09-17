import assert from "node:assert/strict";
import { test } from "node:test";
import { addressFromPrivateKey, readReleaserKey, rlpEncode, suiBurnRef } from "./evmRelease.ts";
import { encodeReleaseV2Calldata, RELEASE_V2_SELECTOR } from "./rhRpc.ts";

test("anvil #0 key derives the well-known address", () => {
  const addr = addressFromPrivateKey(
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  assert.equal(addr, "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266");
});

test("signLegacyTx recovers anvil #0 as signer (cast-verified vector)", async () => {
  const { signLegacyTx } = await import("./evmRelease.ts");
  const raw = signLegacyTx(
    {
      nonce: 0n,
      gasPrice: 1000000000n,
      gas: 21000n,
      to: "0x70997970c51812dc3a010c7d01b50e0d17dc79c8",
      value: 0n,
      data: new Uint8Array(),
      chainId: 1,
    },
    "ac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
  );
  assert.match(raw, /^0xf863/);
  assert.equal(raw.length, 204);
});

test("rlp encodes a single byte < 0x80 as itself", () => {
  const got = rlpEncode(Uint8Array.of(0x7f));
  assert.deepEqual(got, Uint8Array.of(0x7f));
});

test("rlp encodes the empty string as 0x80", () => {
  assert.deepEqual(rlpEncode(new Uint8Array()), Uint8Array.of(0x80));
});

test("readReleaserKey refuses missing or short keys and does not throw the secret", () => {
  const prev = process.env.RH_RELEASER_KEY;
  const prev2 = process.env.RELEASER_KEY;
  delete process.env.RH_RELEASER_KEY;
  delete process.env.RELEASER_KEY;
  try {
    assert.throws(() => readReleaserKey(), /RH_RELEASER_KEY is required/);
    process.env.RH_RELEASER_KEY = "0xab";
    assert.throws(() => readReleaserKey(), /32-byte hex/);
  } finally {
    if (prev === undefined) delete process.env.RH_RELEASER_KEY;
    else process.env.RH_RELEASER_KEY = prev;
    if (prev2 === undefined) delete process.env.RELEASER_KEY;
    else process.env.RELEASER_KEY = prev2;
  }
});

test("encodeReleaseV2Calldata packs (address,uint256,address,bytes32) in order", () => {
  const token = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
  const to = "0x00000000000000000000000000000000000000Aa";
  const ref = "0x" + "11".repeat(32);
  const data = encodeReleaseV2Calldata(token, 10n * 10n ** 18n, to, ref);

  assert.equal(data.slice(0, 10), RELEASE_V2_SELECTOR);
  const body = data.slice(10);
  assert.equal(body.length, 64 * 4, "four abi words");
  assert.equal(body.slice(0, 64), "0".repeat(24) + token.slice(2).toLowerCase());
  assert.equal(BigInt("0x" + body.slice(64, 128)), 10n * 10n ** 18n);
  assert.equal(body.slice(128, 192), "0".repeat(24) + to.slice(2).toLowerCase());
  assert.equal(body.slice(192, 256), "11".repeat(32));
});

test("encodeReleaseV2Calldata refuses a zero amount and a malformed ref", () => {
  const token = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
  const to = "0x00000000000000000000000000000000000000Aa";
  assert.throws(
    () => encodeReleaseV2Calldata(token, 0n, to, "0x" + "11".repeat(32)),
    /amount must be > 0/,
  );
  assert.throws(() => encodeReleaseV2Calldata(token, 1n, to, "0xdeadbeef"), /bad bytes32/);
});

test("suiBurnRef is deterministic, 32 bytes, and separates events in one tx", () => {
  const digest = "67sCFumzPPMYTAdSccEvf9H9aDja73dj3h4Lkjv9uPTP";
  const a = suiBurnRef(digest, 0);
  const b = suiBurnRef(digest, 1);

  assert.match(a, /^0x[0-9a-f]{64}$/);
  assert.equal(a, suiBurnRef(digest, "0"), "stable across number/string eventSeq");
  assert.notEqual(a, b, "two burns in one tx settle independently");
  assert.notEqual(a, suiBurnRef("BwhdFumzPPMYTAdSccEvf9H9aDja73dj3h4Lkjv9uPTP", 0));
  assert.throws(() => suiBurnRef("", 0), /digest is required/);
});
