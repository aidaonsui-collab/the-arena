import { SuiClient } from "@mysten/sui/client";
import { env } from "./config.ts";

export function client() {
  return new SuiClient({ url: env().rpc });
}
