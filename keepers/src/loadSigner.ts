import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { decodeSuiPrivateKey } from "@mysten/sui/cryptography";
import { Ed25519Keypair } from "@mysten/sui/keypairs/ed25519";

export function loadSigner(): Ed25519Keypair {
  const fromEnv = process.env.ARENA_KEEPER_PHRASE ?? "";
  if (fromEnv.trim()) return Ed25519Keypair.deriveKeypair(fromEnv.trim());
  const home = process.env.HOME || homedir();
  const store = process.env.SUI_KEYSTORE || `${home}/.sui/sui_config/sui.keystore`;
  const yaml = readFileSync(`${home}/.sui/sui_config/client.yaml`, "utf8");
  const want = yaml.match(/active_address:\s*"?(0x[0-9a-fA-F]+)/)?.[1]?.toLowerCase();
  const entries = JSON.parse(readFileSync(store, "utf8")) as string[];
  for (const entry of entries) {
    const parsed = decodeSuiPrivateKey(entry);
    const kp = Ed25519Keypair.fromSecretKey(parsed.secretKey);
    if (!want || kp.getPublicKey().toSuiAddress().toLowerCase() === want) return kp;
  }
  throw new Error("no matching key in local Sui keystore");
}
