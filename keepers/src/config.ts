export const XAUM =
  "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";
export const USDY =
  "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY";
export const XAGM =
  "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM";

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
  instadexPitSettle: "events::InstadexPitSettleEvent",
} as const;

export const CLAIM_REFLECTION = 0;
export const CLAIM_PIT = 1;

export function env() {
  const packageId = process.env.ARENA_PACKAGE_ID ?? "";
  const rpc = process.env.SUI_RPC ?? "https://mainnet.suiet.app";
  const pitSui = process.env.ARENA_PIT_SUI ?? "";
  const pitXaum = process.env.ARENA_PIT_XAUM ?? "";
  const pitUsdy = process.env.ARENA_PIT_USDY ?? "";
  const pitXagm = process.env.ARENA_PIT_XAGM ?? "";
  return { packageId, rpc, pitSui, pitXaum, pitUsdy, pitXagm };
}

export function eventType(mod: string, name: string, packageId = env().packageId) {
  return `${packageId}::${mod}::${name}`;
}
