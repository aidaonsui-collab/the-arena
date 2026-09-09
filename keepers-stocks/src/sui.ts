import { SuiClient } from "@mysten/sui/client";
import { env } from "./config.ts";

export function client() {
  return new SuiClient({ url: env().rpc });
}

export type EventCursor = { txDigest: string; eventSeq: string };

/** Same JSON-RPC helper the mint dedupe path uses (`suix_queryEvents`). */
export async function queryEvents(
  type: string,
  cursor: EventCursor | null,
  limit = 50,
  order: "ascending" | "descending" = "ascending",
) {
  return client().queryEvents({
    query: { MoveEventType: type },
    cursor: cursor as never,
    limit,
    order,
  });
}
