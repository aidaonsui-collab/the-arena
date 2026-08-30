import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";
import { fromBase64 } from "@mysten/sui/utils";

function fromStoreEntry(entry: string): Ed25519Keypair {
  if (entry.startsWith("suiprivkey")) {
    return Ed25519Keypair.fromSecretKey(decodeSuiPrivateKey(entry).secretKey);
  }
  const raw = fromBase64(entry);
  const secret = raw.length === 33 ? raw.slice(1) : raw;
  return Ed25519Keypair.fromSecretKey(secret);
}

export function loadSigner(): Ed25519Keypair {
  const fromEnv = process.env.ARENA_KEEPER_PHRASE ?? "";
  if (fromEnv.trim()) return Ed25519Keypair.deriveKeypair(fromEnv.trim());
  const home = process.env.HOME || homedir();
  const store = process.env.SUI_KEYSTORE || `${home}/.sui/sui_config/sui.keystore`;
  const yaml = readFileSync(`${home}/.sui/sui_config/client.yaml`, "utf8");
  const want = yaml.match(/active_address:\s*"?(0x[0-9a-fA-F]+)/)?.[1]?.toLowerCase();
  const entries = JSON.parse(readFileSync(store, "utf8")) as string[];
  for (const entry of entries) {
    const kp = fromStoreEntry(entry);
    if (!want || kp.getPublicKey().toSuiAddress().toLowerCase() === want) return kp;
  }
  throw new Error("no matching key in local Sui keystore");
}
