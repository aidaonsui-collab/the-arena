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
  "0x5175c397e0f70475dcc4ae3d60e1d5984a35f1b762c941275ab7bb09aabd94fe";
export const SUI = "0x2::sui::SUI";
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
