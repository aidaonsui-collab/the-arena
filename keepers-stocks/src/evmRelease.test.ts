import assert from "node:assert/strict";
import { test } from "node:test";
import { addressFromPrivateKey, readReleaserKey, rlpEncode } from "./evmRelease.ts";

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
