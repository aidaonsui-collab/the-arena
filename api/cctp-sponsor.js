// Pays Sui gas from the platform wallet for a CCTP buy.
// The mint is sent by the platform. The swap is a sponsored transaction:
// the buyer signs, the platform adds the gas signature.
// ARENA_KEEPER_PHRASE must be the platform wallet. The phrase never leaves the server.
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { SuiClient } from "@mysten/sui/client";
import { Transaction } from "@mysten/sui/transactions";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { normalizeSuiAddress, fromBase64, toBase64 } from "@mysten/sui/utils";
import { verifyPersonalMessageSignature, verifyTransactionSignature } from "@mysten/sui/verify";

const PLATFORM = "0x92a32ac7fd525f8bd37ed359423b8d7d858cad26224854dfbff1914b75ee658b";
const USDC = "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
const RPCS = [
  "https://rpc-mainnet.suiscan.xyz:443",
  "https://sui-mainnet-endpoint.blockvision.org",
  "https://mainnet.suiet.app"
];
const CCTP = {
  mtPackage: "0x16bcfcfc465f96281663a344641c017de84529370e11aa3879d0dce43ad6db87",
  mtState: "0x0c067f7d325e5b60e3179712e7783534ba1556cbb3d359d8161497e37689230c",
  tmmPackage: "0xeb14978abfe93a37c5d5bf86a0623b923553a5f0e794daac7724f1e2fdbfb830",
  tmmState: "0x06fb166941cd7bc095edc019d054a753ec3f1e4c25f28f2ecc4a6cfa0a9b1167",
  handlerPackage: "0x185ed207c4d64fc594882ab927f9f3c6ff957aad03df8a731ba64378faeeb2bf",
  handlerState: "0xa32de8a6dd0178fb05f662929d55cddb69a25c26bde4b83f89e36d17ead94c41",
  treasury: "0x57d6725e7a8b49a7b2a612f6bd66ab5f39fc95332ca48be421c3229d514a6de7",
  denyList: "0x403",
  clock: "0x6"
};
const BLUEFIN = "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c";
const CETUS = "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3";
const MINT_BUDGET = 50_000_000;
const SWAP_BUDGETS = [80_000_000, 150_000_000];
const TICKET_MS = 30 * 60 * 1000;

const ALLOW = {
  [normalizeSuiAddress("0x2")]: {
    coin: ["value", "split", "into_balance", "from_balance"],
    balance: ["zero"]
  },
  [normalizeSuiAddress(BLUEFIN)]: { pool: ["swap"] },
  [normalizeSuiAddress(CETUS)]: { pool: ["flash_swap", "swap_pay_amount", "repay_flash_swap"] }
};

function json(body, status) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" }
  });
}

function sameAddr(a, b) {
  try { return normalizeSuiAddress(a) === normalizeSuiAddress(b); }
  catch { return false; }
}

function hexToBytes(hex) {
  const h = String(hex || "").replace(/^0x/i, "");
  if (!h || h.length % 2 || !/^[0-9a-fA-F]+$/.test(h)) throw new Error("Message is not hex");
  if (h.length > 20000) throw new Error("Message is too large");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function loadSponsor() {
  const raw = String(process.env.ARENA_KEEPER_PHRASE || "").trim();
  if (!raw) return null;
  let kp;
  if (raw.startsWith("suiprivkey")) {
    kp = Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(raw).secretKey);
  } else if (raw.split(/\s+/).length >= 12) {
    kp = Ed25519Keypair.deriveKeypair(raw);
  } else {
    const buf = fromBase64(raw);
    const secret = buf.length === 33 ? buf.slice(1) : buf;
    kp = Ed25519Keypair.fromSecretKey(secret);
  }
  if (!sameAddr(kp.getPublicKey().toSuiAddress(), PLATFORM)) {
    throw new Error("Sponsor key is not the platform wallet");
  }
  return kp;
}

async function suiClient() {
  let last;
  for (const url of RPCS) {
    const client = new SuiClient({ url });
    try {
      await client.getLatestCheckpointSequenceNumber();
      return client;
    } catch (e) {
      last = e;
    }
  }
  throw last || new Error("Sui RPC unavailable");
}

function usesGas(node) {
  if (!node || typeof node !== "object") return false;
  if (node.$kind === "GasCoin" || node.GasCoin === true) return true;
  if (Array.isArray(node)) return node.some(usesGas);
  return Object.keys(node).some((k) => usesGas(node[k]));
}

function pureAddress(input) {
  if (!input) return "";
  if (input.$kind === "UnresolvedPure") return String(input.UnresolvedPure && input.UnresolvedPure.value || "");
  const raw = input.Pure && input.Pure.bytes;
  if (typeof raw !== "string") return "";
  const bytes = fromBase64(raw);
  if (bytes.length !== 32) return "";
  return normalizeSuiAddress("0x" + Buffer.from(bytes).toString("hex"));
}

function inputObjectId(input) {
  const src = (input && (input.UnresolvedObject || input.Object)) || null;
  if (!src) return "";
  const id = src.objectId || (src.ImmOrOwned && src.ImmOrOwned.objectId) || (src.Shared && src.Shared.objectId) || (src.Receiving && src.Receiving.objectId) || "";
  return id ? normalizeSuiAddress(id) : "";
}

export function assertSwapCommands(tx, sender, coinId) {
  const data = tx.getData();
  const commands = data.commands || [];
  if (!commands.length || commands.length > 30) throw routeError("Swap is empty or too large");
  if (usesGas(commands)) throw routeError("Swap must not spend the gas coin");
  let sawCoin = false;
  const wantCoin = normalizeSuiAddress(coinId);
  for (const input of data.inputs || []) {
    if (inputObjectId(input) === wantCoin) sawCoin = true;
  }
  if (!sawCoin) throw routeError("Swap does not spend the minted USDC");
  for (const cmd of commands) {
    if (cmd.$kind === "SplitCoins" || cmd.$kind === "MergeCoins") continue;
    if (cmd.$kind === "TransferObjects") {
      const arg = cmd.TransferObjects && cmd.TransferObjects.address;
      const input = arg && arg.$kind === "Input" ? data.inputs[arg.Input] : null;
      const dest = pureAddress(input);
      if (!dest || !sameAddr(dest, sender)) throw routeError("Swap sends coins somewhere other than the buyer");
      continue;
    }
    if (cmd.$kind !== "MoveCall") throw routeError("Swap uses a command Vicefun does not sponsor");
    const call = cmd.MoveCall || {};
    const pkg = normalizeSuiAddress(call.package);
    const allowed = ALLOW[pkg];
    const fns = allowed && allowed[call.module];
    if (!fns || fns.indexOf(call.function) < 0) {
      throw routeError("This pair's route is not covered. A little SUI is still required.");
    }
  }
}

function routeError(message) {
  const err = new Error(message);
  err.code = "route";
  return err;
}

async function signTicket(signer, recipient, coinId) {
  const payload = JSON.stringify({
    v: 1,
    recipient: normalizeSuiAddress(recipient),
    coinId: normalizeSuiAddress(coinId),
    exp: Date.now() + TICKET_MS
  });
  const signed = await signer.signPersonalMessage(new TextEncoder().encode(payload));
  return Buffer.from(payload).toString("base64url") + "." + signed.signature;
}

async function readTicket(ticket, sender, coinId) {
  const parts = String(ticket || "").split(".");
  if (parts.length !== 2) throw new Error("Missing gas ticket");
  const payload = Buffer.from(parts[0], "base64url").toString();
  await verifyPersonalMessageSignature(new TextEncoder().encode(payload), parts[1], { address: PLATFORM });
  const data = JSON.parse(payload);
  if (!data || data.v !== 1 || Number(data.exp) < Date.now()) throw new Error("Gas ticket expired. Mint again.");
  if (!sameAddr(data.recipient, sender)) throw new Error("Gas ticket is for a different wallet");
  if (coinId && !sameAddr(data.coinId, coinId)) throw new Error("Gas ticket is for a different USDC coin");
  return data;
}

function mintedCoin(result, recipient) {
  const changes = (result && result.objectChanges) || [];
  for (const ch of changes) {
    if (!ch || ch.type !== "created") continue;
    const type = String(ch.objectType || "");
    if (type.indexOf("::usdc::USDC") < 0) continue;
    const owner = ch.owner && (ch.owner.AddressOwner || ch.owner);
    if (!sameAddr(owner, recipient)) continue;
    return ch.objectId;
  }
  return "";
}

async function mint(body) {
  const signer = loadSponsor();
  if (!signer) return json({ sponsor: false, error: "Sui gas sponsor is not configured" }, 503);
  const recipient = normalizeSuiAddress(body.recipient || "");
  const message = hexToBytes(body.message);
  const attestation = hexToBytes(body.attestation);
  const tx = new Transaction();
  tx.setSender(signer.getPublicKey().toSuiAddress());
  tx.setGasBudget(MINT_BUDGET);
  const [receipt] = tx.moveCall({
    target: `${CCTP.mtPackage}::receive_message::receive_message`,
    arguments: [tx.pure.vector("u8", Array.from(message)), tx.pure.vector("u8", Array.from(attestation)), tx.object(CCTP.mtState)]
  });
  const [mintReceipt] = tx.moveCall({
    target: `${CCTP.tmmPackage}::handle_receive_message::prepare_mint`,
    typeArguments: [USDC],
    arguments: [receipt, tx.object(CCTP.tmmState), tx.object(CCTP.clock)]
  });
  const [ticket] = tx.moveCall({
    target: `${CCTP.handlerPackage}::handler::mint`,
    arguments: [
      tx.object(CCTP.handlerState),
      mintReceipt,
      tx.object(CCTP.tmmState),
      tx.object(CCTP.treasury),
      tx.object(CCTP.denyList)
    ]
  });
  tx.moveCall({
    target: `${CCTP.tmmPackage}::handle_receive_message::complete_mint`,
    typeArguments: [USDC, `${CCTP.handlerPackage}::handler::Auth`],
    arguments: [ticket, tx.object(CCTP.tmmState), tx.object(CCTP.mtState)]
  });
  const client = await suiClient();
  const bytes = await tx.build({ client });
  const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
  const st = dry.effects && dry.effects.status;
  if (!st || st.status !== "success") throw new Error((st && st.error) || "Mint dry-run failed");
  const { signature } = await signer.signTransaction(bytes);
  const built = await client.executeTransactionBlock({
    transactionBlock: bytes,
    signature,
    options: { showEffects: true, showObjectChanges: true }
  });
  const coinId = mintedCoin(built, recipient);
  if (!coinId) throw new Error("Mint landed but the USDC coin was not found");
  const gasTicket = await signTicket(signer, recipient, coinId);
  return json({
    sponsor: true,
    digest: built.digest,
    objectChanges: built.objectChanges || [],
    coinId,
    ticket: gasTicket
  }, 200);
}

async function buildSwap(kind, sender, coinId) {
  const signer = loadSponsor();
  if (!signer) return null;
  const sponsor = signer.getPublicKey().toSuiAddress();
  let last;
  for (const budget of SWAP_BUDGETS) {
    const tx = Transaction.fromKind(kind);
    tx.setSender(sender);
    tx.setGasOwner(sponsor);
    tx.setGasBudget(budget);
    assertSwapCommands(tx, sender, coinId);
    try {
      const client = await suiClient();
      const bytes = await tx.build({ client });
      const dry = await client.dryRunTransactionBlock({ transactionBlock: bytes });
      const st = dry.effects && dry.effects.status;
      if (!st || st.status !== "success") throw new Error((st && st.error) || "Swap dry-run failed");
      return { bytes };
    } catch (e) {
      last = e;
      if (e && e.code === "route") throw e;
      const msg = String((e && e.message) || "");
      if (!/gas|budget/i.test(msg)) throw e;
    }
  }
  throw last || new Error("Could not sponsor the swap");
}

async function swap(body) {
  const signer = loadSponsor();
  if (!signer) return json({ sponsor: false, error: "Sui gas sponsor is not configured" }, 503);
  const sender = normalizeSuiAddress(body.sender || "");
  const coinId = normalizeSuiAddress(body.coinId || "");
  await readTicket(body.ticket, sender, coinId);
  const kind = String(body.kind || "");
  if (!kind || kind.length > 120000) throw new Error("Swap transaction is missing");
  const built = await buildSwap(kind, sender, coinId);
  return json({ sponsor: true, bytes: toBase64(built.bytes) }, 200);
}

async function execute(body) {
  const signer = loadSponsor();
  if (!signer) return json({ sponsor: false, error: "Sui gas sponsor is not configured" }, 503);
  const sender = normalizeSuiAddress(body.sender || "");
  const bytes = fromBase64(String(body.bytes || ""));
  const tx = Transaction.from(bytes);
  const data = tx.getData();
  if (!sameAddr(data.sender, sender)) throw new Error("Swap sender changed");
  if (!sameAddr(data.gasData && data.gasData.owner, PLATFORM)) throw new Error("Gas owner is not the platform wallet");
  const budget = Number(data.gasData && data.gasData.budget || 0);
  if (!(budget > 0) || budget > SWAP_BUDGETS[SWAP_BUDGETS.length - 1]) throw new Error("Gas budget is not allowed");
  const ticket = await readTicket(body.ticket, sender, "");
  assertSwapCommands(tx, sender, ticket.coinId);
  await verifyTransactionSignature(bytes, String(body.signature || ""), { address: sender });
  const { signature } = await signer.signTransaction(bytes);
  const client = await suiClient();
  const result = await client.executeTransactionBlock({
    transactionBlock: bytes,
    signature: [String(body.signature), signature],
    options: { showEffects: true, showObjectChanges: true }
  });
  const st = result.effects && result.effects.status;
  if (st && st.status && st.status !== "success") throw new Error(st.error || "Sponsored swap failed");
  return json({ sponsor: true, digest: result.digest, objectChanges: result.objectChanges || [] }, 200);
}

export function GET() {
  let on = false;
  try { on = !!loadSponsor(); }
  catch { on = false; }
  return json({ sponsor: on }, 200);
}

export async function POST(request) {
  const origin = request.headers.get("origin") || "";
  if (origin && !/^https:\/\/(([a-z0-9-]+\.)?vicefun\.com|[a-z0-9-]+\.vercel\.app)$/i.test(origin) && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin)) {
    return json({ error: "bad origin" }, 403);
  }
  let body;
  try { body = await request.json(); }
  catch { return json({ error: "invalid json" }, 400); }
  try {
    const action = body && body.action;
    if (action === "mint") return await mint(body);
    if (action === "swap") return await swap(body);
    if (action === "execute") return await execute(body);
    return json({ error: "unknown action" }, 400);
  } catch (e) {
    const message = (e && e.message) ? e.message : "Gas sponsor failed";
    const status = e && e.code === "route" ? 422 : 400;
    return json({ error: message, code: (e && e.code) || "" }, status);
  }
}
