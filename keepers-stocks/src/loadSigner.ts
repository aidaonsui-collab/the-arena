import { readFileSync, existsSync } from "node:fs";
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

/** True when a phrase or keystore is available (does not load yet). */
export function hasSignerMaterial(): boolean {
  if ((process.env.ARENA_KEEPER_PHRASE ?? "").trim()) return true;
  const home = process.env.HOME || homedir();
  const store = process.env.SUI_KEYSTORE || `${home}/.sui/sui_config/sui.keystore`;
  return existsSync(store);
}

/**
 * Same pattern as arena keepers: ARENA_KEEPER_PHRASE, else local Sui keystore.
 * Live mint requires the MinterCap holder (0x92a32…).
 */
export function loadSigner(): Ed25519Keypair {
  const fromEnv = process.env.ARENA_KEEPER_PHRASE ?? "";
  if (fromEnv.trim()) return Ed25519Keypair.deriveKeypair(fromEnv.trim());
  const home = process.env.HOME || homedir();
  const store = process.env.SUI_KEYSTORE || `${home}/.sui/sui_config/sui.keystore`;
  const yamlPath = `${home}/.sui/sui_config/client.yaml`;
  let want = (process.env.ARENA_KEEPER_ADDRESS || "").toLowerCase();
  if (!want && existsSync(yamlPath)) {
    const yaml = readFileSync(yamlPath, "utf8");
    want = (yaml.match(/active_address:\s*"?(0x[0-9a-fA-F]+)/)?.[1] || "").toLowerCase();
  }
  if (!existsSync(store)) throw new Error("no ARENA_KEEPER_PHRASE and no local Sui keystore");
  const entries = JSON.parse(readFileSync(store, "utf8")) as string[];
  for (const entry of entries) {
    const kp = fromStoreEntry(entry);
    if (!want || kp.getPublicKey().toSuiAddress().toLowerCase() === want) return kp;
  }
  throw new Error("no matching key in local Sui keystore");
}
