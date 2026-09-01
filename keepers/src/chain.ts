import { client } from "./sui.ts";

export const CLOCK = "0x6";
export const CONFIG =
  process.env.ARENA_CONFIG || "0xcd527cb2389d806e5285ae708ee28df30a841ec5df7508ebfebaa0c9660b5d2c";
export const PIT_SUI =
  process.env.ARENA_PIT_SUI || "0x8ec38e9bcac0838bf474680e71d0c3f302f4ea2f757d759b7b399701f904389c";
export const PIT_XAUM =
  process.env.ARENA_PIT_XAUM || "0xa8a391bf380914c04be5deb478474b42754a5aa8c29c0955f267d73190a98783";
export const CALL_PKG =
  process.env.ARENA_CALL_PACKAGE ??
  "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9";
export const ADMIN_CAP =
  process.env.ARENA_ADMIN_CAP ||
  "0x79e041a4444971bfbf8000925ac3386d8351a3e997eb7d838d84eb6c3e507acf";
export const SUI = "0x2::sui::SUI";
export const USDY =
  "0x960b531667636f39e85867775f52f6b1f220a058c4de786905bdf761e06a56bb::usdy::USDY";
export const XAGM =
  "0x64bddec0f898ccaa022b8a6e0a5f75d80f53177b87a9795dd15aefe9ac12ee6c::xagm::XAGM";
export const USDC =
  "0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC";
export const BLUEFIN_SPOT =
  process.env.ARENA_BLUEFIN_SPOT ||
  "0xd075338d105482f1527cbfd363d6413558f184dec36d9138a70261e87f486e9c";
export const BLUEFIN_CONFIG =
  process.env.ARENA_BLUEFIN_CONFIG ||
  "0x03db251ba509a8d5d8777b6338836082335d93eecbdd09a11e190a1cff51c352";
export const CETUS_CLMM =
  process.env.ARENA_CETUS_CLMM ||
  "0x25ebb9a7c50eb17b3fa9c5a30fb8b5ad8f97caaf4928943acbcff7153dfee5e3";
export const CETUS_CONFIG =
  process.env.ARENA_CETUS_CONFIG ||
  "0xdaa46292632c3c4d8f31f23ea0f9b36a28ff3677e9684980e4438403a67a3d8f";
export const USDY_USDC_POOL =
  "0xdcd762ad374686fa890fc4f3b9bbfe2a244e713d7bffbfbd1b9221cb290da2ed";
export const XAGM_USDC_POOL =
  "0x4d3cc875e334440ad3485d4455d7ee072ea01b18c526ad64f9ebe2aa0a4f01b9";
export const USDC_SUI_POOL =
  "0x51e883ba7c0b566a26cbc8a94cd33eb0abd418a77cc1e60ad22fd9b1f29cd2ab";
export const XAUM_USDC_POOL =
  "0x458fc3722cc88babd7cbe78273aa5e4ecbdff75c76a2ad14cd1f75418b569649";
export const APP_URL = (process.env.ARENA_APP_URL || "https://the-arena-vert.vercel.app").replace(/\/$/, "");
export const XAUM =
  "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";
export const GQL = process.env.SUI_GRAPHQL ?? "https://graphql.mainnet.sui.io/graphql";

export function asId(v: unknown): string {
  if (typeof v === "string") return v.startsWith("0x") ? v : `0x${v}`;
  if (v && typeof v === "object" && "id" in (v as object)) return asId((v as { id: unknown }).id);
  return String(v ?? "");
}

export function parseOptionId(v: unknown): string | null {
  if (v == null || v === "" || v === "0x0") return null;
  if (typeof v === "string") return asId(v);
  if (typeof v !== "object") return null;
  const o = v as { vec?: unknown[]; some?: unknown };
  if (Array.isArray(o.vec)) {
    if (!o.vec.length) return null;
    return asId(o.vec[0]);
  }
  if (o.some != null) return asId(o.some);
  return null;
}

export function typeNameOf(v: unknown): string {
  if (v == null || v === "") return "";
  if (typeof v === "string") return v;
  if (typeof v === "object") {
    const o = v as { name?: string; address?: string; module?: string };
    if (o.address && o.module) return `${o.address}::${o.module}::${o.name ?? ""}`;
    if (o.name) return String(o.name);
  }
  return String(v);
}

export async function gql(query: string, variables: Record<string, unknown>) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  const j = (await r.json()) as { data?: unknown; errors?: { message: string }[] };
  if (j.errors?.length) throw new Error(j.errors[0].message);
  return j.data;
}

export async function objectFields(id: string): Promise<{ type: string; fields: Record<string, unknown> } | null> {
  const obj = await client().getObject({ id, options: { showContent: true, showType: true } });
  const content = obj.data?.content;
  if (!content || content.dataType !== "moveObject") return null;
  return {
    type: String(obj.data?.type || content.type || ""),
    fields: (content.fields || {}) as Record<string, unknown>,
  };
}

export function poolTypeArgs(type: string): [string, string] | null {
  const m = type.match(/::pool::Pool<(.+)>$/);
  if (!m) return null;
  const inner = m[1];
  const parts: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of inner) {
    if (ch === "<") depth++;
    if (ch === ">") depth--;
    if (ch === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  if (parts.length !== 2) return null;
  return [parts[0], parts[1]];
}
