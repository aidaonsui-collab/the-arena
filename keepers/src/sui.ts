import { SuiClient } from "@mysten/sui/client";
import { env, eventType } from "./config.ts";

export function client() {
  return new SuiClient({ url: env().rpc });
}

export async function queryEvents(type: string, cursor: string | null, limit = 50) {
  const c = client();
  return c.queryEvents({
    query: { MoveEventType: type },
    cursor: cursor as never,
    limit,
    order: "ascending",
  });
}

export function tradeEventType() {
  const { packageId } = env();
  if (!packageId) throw new Error("ARENA_PACKAGE_ID is required");
  return eventType("events", "TradeEvent");
}

export function claimEventType() {
  return eventType("events", "ClaimEvent");
}
