/**
 * Build (and optionally sign) stocks::bridge::mint PTB.
 * Dry-run prints the PTB when no key / --dry-run.
 */
import { Transaction } from "@mysten/sui/transactions";
import { MINTER_HOLDER, STOCKS_PACKAGE, stockOf, type StockConfig } from "./config.ts";
import { localLookup, normalizeRhRefKey, onChainLookup, recordMint } from "./dedupe.ts";
import { hasSignerMaterial, loadSigner } from "./loadSigner.ts";
import { client } from "./sui.ts";

export type MintArgs = {
  ticker: string;
  /** Base units (18 decimals). */
  amount: string | bigint;
  recipient: string;
  rhRef: string;
  dryRun?: boolean;
  skipOnChainDedupe?: boolean;
};

export type MintResult = {
  mode: "dry-run" | "executed";
  ticker: string;
  coinType: string;
  vaultId: string;
  minterCapId: string;
  amount: string;
  recipient: string;
  rhRef: string;
  rhRefHex: string;
  packageId: string;
  target: string;
  ptb: {
    sender?: string;
    moveCall: {
      target: string;
      typeArguments: string[];
      arguments: string[];
    };
  };
  dedupe?: { local?: unknown; onChain?: unknown };
  dryRunEffects?: unknown;
  digest?: string;
  status?: string;
  signer?: string;
  note?: string;
};

function parseAmount(a: string | bigint): bigint {
  if (typeof a === "bigint") return a;
  const s = String(a).trim();
  if (!/^\d+$/.test(s)) throw new Error(`amount must be integer base units, got ${a}`);
  const n = BigInt(s);
  if (n <= 0n) throw new Error("amount must be > 0");
  return n;
}

function normalizeAddress(addr: string): string {
  const a = addr.trim().toLowerCase();
  if (!/^0x[0-9a-f]{1,64}$/.test(a)) throw new Error(`bad recipient address: ${addr}`);
  return a.length === 66 ? a : `0x${a.slice(2).padStart(64, "0")}`;
}

export function buildMintTx(stock: StockConfig, amount: bigint, recipient: string, rhBytes: number[]): Transaction {
  const tx = new Transaction();
  tx.moveCall({
    target: `${STOCKS_PACKAGE}::bridge::mint`,
    typeArguments: [stock.coinType],
    arguments: [
      tx.object(stock.vaultId),
      tx.object(stock.minterCapId),
      tx.pure.u64(amount),
      tx.pure.address(recipient),
      tx.pure.vector("u8", rhBytes),
    ],
  });
  return tx;
}

export async function runMint(args: MintArgs): Promise<MintResult> {
  const stock = stockOf(args.ticker);
  const amount = parseAmount(args.amount);
  const recipient = normalizeAddress(args.recipient);
  const { key, bytes, display } = normalizeRhRefKey(args.rhRef);

  const wantDry =
    args.dryRun === true ||
    process.env.STOCKS_MINT_DRY_RUN === "1" ||
    !hasSignerMaterial();

  const local = localLookup(key);
  if (local && !local.dryRun) {
    throw new Error(
      `dedupe: rh_ref already used locally (digest=${local.digest ?? "n/a"} at ${local.at})`,
    );
  }

  let onChain: { digest: string; amount?: string } | null = null;
  if (!args.skipOnChainDedupe) {
    try {
      onChain = await onChainLookup(key);
    } catch (e) {
      // RPC may be flaky; local dedupe still applies
      console.warn("on-chain dedupe skipped:", e instanceof Error ? e.message : e);
    }
  }
  if (onChain) {
    throw new Error(`dedupe: rh_ref already minted on-chain (digest=${onChain.digest})`);
  }

  const tx = buildMintTx(stock, amount, recipient, bytes);
  const target = `${STOCKS_PACKAGE}::bridge::mint`;
  const ptbSummary = {
    moveCall: {
      target,
      typeArguments: [stock.coinType],
      arguments: [
        `object(${stock.vaultId})`,
        `object(${stock.minterCapId})`,
        `u64(${amount})`,
        `address(${recipient})`,
        `vector<u8>(${bytes.length} bytes, ${display})`,
      ],
    },
  };

  const base: MintResult = {
    mode: wantDry ? "dry-run" : "executed",
    ticker: stock.ticker,
    coinType: stock.coinType,
    vaultId: stock.vaultId,
    minterCapId: stock.minterCapId,
    amount: amount.toString(),
    recipient,
    rhRef: display,
    rhRefHex: key,
    packageId: STOCKS_PACKAGE,
    target,
    ptb: ptbSummary,
    dedupe: { local: local ?? null, onChain: onChain ?? null },
    note: `MinterCap must stay on ${MINTER_HOLDER}. Do not transfer.`,
  };

  if (wantDry) {
    // Prefer a concrete sender for inspect when we have a key; else use minter holder.
    let sender = MINTER_HOLDER;
    let signerAddr: string | undefined;
    if (hasSignerMaterial()) {
      try {
        const kp = loadSigner();
        sender = kp.getPublicKey().toSuiAddress();
        signerAddr = sender;
      } catch {
        /* keep holder */
      }
    }
    tx.setSender(sender);
    base.ptb.sender = sender;
    base.signer = signerAddr;

    try {
      const bytesBuilt = await tx.build({ client: client() });
      const inspected = await client().dryRunTransactionBlock({
        transactionBlock: bytesBuilt,
      });
      base.dryRunEffects = {
        status: inspected.effects?.status,
        // Truncate events for readability
        events: (inspected.events ?? []).map((e) => ({
          type: e.type,
          parsedJson: e.parsedJson,
        })),
        error: inspected.effects?.status?.error,
      };
    } catch (e) {
      base.dryRunEffects = {
        buildOrInspectError: e instanceof Error ? e.message : String(e),
        hint: "PTB was still constructed; inspect failed (RPC / ownership). Summary above is enough for operators.",
      };
    }

    recordMint({
      rhRef: key,
      rhRefHex: key,
      ticker: stock.ticker,
      amount: amount.toString(),
      recipient,
      at: new Date().toISOString(),
      dryRun: true,
    });
    return base;
  }

  const kp = loadSigner();
  const signer = kp.getPublicKey().toSuiAddress();
  base.signer = signer;
  base.ptb.sender = signer;
  if (signer.toLowerCase() !== MINTER_HOLDER.toLowerCase()) {
    console.warn(
      `warning: signer ${signer} is not MinterCap holder ${MINTER_HOLDER}; mint will fail unless cap was shared/transferred (do not transfer).`,
    );
  }

  const sent = await client().signAndExecuteTransaction({
    signer: kp,
    transaction: tx,
    options: { showEffects: true, showEvents: true },
  });
  base.digest = sent.digest;
  base.status = sent.effects?.status?.status;
  base.mode = "executed";

  recordMint({
    rhRef: key,
    rhRefHex: key,
    ticker: stock.ticker,
    amount: amount.toString(),
    recipient,
    digest: sent.digest,
    at: new Date().toISOString(),
    dryRun: false,
  });
  return base;
}

/** Accept webhook / manual attestation payload. */
export async function attestAndMint(payload: {
  ticker: string;
  amount: string | bigint;
  recipient: string;
  rh_tx_hash?: string;
  rh_ref?: string;
  dry_run?: boolean;
}) {
  const rhRef = payload.rh_ref ?? payload.rh_tx_hash;
  if (!rhRef) throw new Error("rh_ref or rh_tx_hash required");
  return runMint({
    ticker: payload.ticker,
    amount: payload.amount,
    recipient: payload.recipient,
    rhRef,
    dryRun: payload.dry_run,
  });
}
