import type { Transaction, TransactionObjectArgument } from "@mysten/sui/transactions";
import {
  BLUEFIN_CONFIG,
  BLUEFIN_SPOT,
  CETUS_CLMM,
  CETUS_CONFIG,
  CLOCK,
  poolTypeArgs,
} from "./chain.ts";
import { client } from "./sui.ts";

export type PoolSnap = { id: string; type: string; a: string; b: string };

export function normType(t: string): string {
  let s = String(t || "").trim();
  if (!s) return "";
  if (!s.startsWith("0x") && s.includes("::")) s = "0x" + s;
  s = s.replace(/^0x0+/, "0x");
  if (s.startsWith("0x::")) s = "0x0" + s.slice(2);
  if (s === "0x2::sui::SUI" || s.endsWith("::sui::SUI")) return "0x2::sui::SUI";
  return s;
}

function nested0(res: unknown) {
  if (res && typeof res === "object" && 0 in (res as object)) return (res as { 0: unknown })[0];
  return res;
}

export async function poolSnap(id: string): Promise<PoolSnap> {
  const obj = await client().getObject({ id, options: { showContent: true, showType: true } });
  const type = String(obj.data?.type || "");
  const parts = poolTypeArgs(type);
  if (!parts) throw new Error("not a Pool: " + type);
  return { id, type, a: normType(parts[0]), b: normType(parts[1]) };
}

function coinValue(tx: Transaction, type: string, coin: TransactionObjectArgument) {
  return nested0(
    tx.moveCall({
      target: "0x2::coin::value",
      typeArguments: [type],
      arguments: [coin],
    }),
  ) as TransactionObjectArgument;
}

function intoBalance(tx: Transaction, type: string, coin: TransactionObjectArgument) {
  return nested0(
    tx.moveCall({
      target: "0x2::coin::into_balance",
      typeArguments: [type],
      arguments: [coin],
    }),
  ) as TransactionObjectArgument;
}

function fromBalance(tx: Transaction, type: string, bal: TransactionObjectArgument) {
  return nested0(
    tx.moveCall({
      target: "0x2::coin::from_balance",
      typeArguments: [type],
      arguments: [bal],
    }),
  ) as TransactionObjectArgument;
}

function zeroBalance(tx: Transaction, type: string) {
  return nested0(
    tx.moveCall({
      target: "0x2::balance::zero",
      typeArguments: [type],
      arguments: [],
    }),
  ) as TransactionObjectArgument;
}

function sqrtLimit(a2b: boolean): string {
  return a2b ? "4295048017" : "79226673515401279992447579054";
}

export function bluefinHop(
  tx: Transaction,
  snap: PoolSnap,
  fromType: string,
  coinIn: TransactionObjectArgument,
  minOut: bigint,
  leftoverTo: string,
): TransactionObjectArgument {
  const from = normType(fromType);
  const a2b = from === snap.a;
  const amountArg = coinValue(tx, from, coinIn);
  const inBal = intoBalance(tx, from, coinIn);
  const outType = a2b ? snap.b : snap.a;
  const z = zeroBalance(tx, outType);
  const res = tx.moveCall({
    target: `${BLUEFIN_SPOT}::pool::swap`,
    typeArguments: [snap.a, snap.b],
    arguments: [
      tx.object(CLOCK),
      tx.object(BLUEFIN_CONFIG),
      tx.object(snap.id),
      a2b ? inBal : z,
      a2b ? z : inBal,
      tx.pure.bool(a2b),
      tx.pure.bool(true),
      amountArg,
      tx.pure.u64(minOut),
      tx.pure.u128(BigInt(sqrtLimit(a2b))),
    ],
  });
  const outA = fromBalance(tx, snap.a, res[0]);
  const outB = fromBalance(tx, snap.b, res[1]);
  if (a2b) {
    tx.transferObjects([outA], leftoverTo);
    return outB;
  }
  tx.transferObjects([outB], leftoverTo);
  return outA;
}

export function cetusHop(
  tx: Transaction,
  snap: PoolSnap,
  fromType: string,
  coinIn: TransactionObjectArgument,
  leftoverTo: string,
): TransactionObjectArgument {
  const from = normType(fromType);
  const a2b = from === snap.a;
  const amountArg = coinValue(tx, from, coinIn);
  const res = tx.moveCall({
    target: `${CETUS_CLMM}::pool::flash_swap`,
    typeArguments: [snap.a, snap.b],
    arguments: [
      tx.object(CETUS_CONFIG),
      tx.object(snap.id),
      tx.pure.bool(a2b),
      tx.pure.bool(true),
      amountArg,
      tx.pure.u128(BigInt(sqrtLimit(a2b))),
      tx.object(CLOCK),
    ],
  });
  const receiveA = res[0];
  const receiveB = res[1];
  const receipt = res[2];
  const payAmt = nested0(
    tx.moveCall({
      target: `${CETUS_CLMM}::pool::swap_pay_amount`,
      typeArguments: [snap.a, snap.b],
      arguments: [receipt],
    }),
  ) as TransactionObjectArgument;
  const paySplit = tx.splitCoins(coinIn, [payAmt]);
  const payCoin = Array.isArray(paySplit) ? paySplit[0] : paySplit;
  const payBal = intoBalance(tx, from, payCoin);
  const payA = a2b ? payBal : zeroBalance(tx, snap.a);
  const payB = a2b ? zeroBalance(tx, snap.b) : payBal;
  tx.moveCall({
    target: `${CETUS_CLMM}::pool::repay_flash_swap`,
    typeArguments: [snap.a, snap.b],
    arguments: [tx.object(CETUS_CONFIG), tx.object(snap.id), payA, payB, receipt],
  });
  tx.transferObjects([coinIn], leftoverTo);
  const dust = fromBalance(tx, a2b ? snap.a : snap.b, a2b ? receiveA : receiveB);
  tx.transferObjects([dust], leftoverTo);
  return fromBalance(tx, a2b ? snap.b : snap.a, a2b ? receiveB : receiveA);
}
