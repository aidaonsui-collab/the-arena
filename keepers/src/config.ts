export const XAUM =
  "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";

export const SUI = "0x2::sui::SUI";

/** Move event types the indexer and @Arena UI should subscribe to. */
export const EVENTS = {
  launch: "launch::LaunchEvent",
  trade: "events::TradeEvent",
  claim: "events::ClaimEvent",
  bell: "events::BellEvent",
  pitSettle: "events::PitSettleEvent",
  pitNudge: "events::PitNudgeEvent",
  graduation: "events::GraduationEvent",
} as const;

export const CLAIM_REFLECTION = 0;
export const CLAIM_PIT = 1;

export function env() {
  const packageId = process.env.ARENA_PACKAGE_ID ?? "";
  const rpc = process.env.SUI_RPC ?? "https://fullnode.mainnet.sui.io:443";
  const pitSui = process.env.ARENA_PIT_SUI ?? "";
  const pitXaum = process.env.ARENA_PIT_XAUM ?? "";
  return { packageId, rpc, pitSui, pitXaum };
}

export function eventType(mod: string, name: string, packageId = env().packageId) {
  return `${packageId}::${mod}::${name}`;
}
