import { head } from "@vercel/blob";

const mem = new Map();
const TTL_MS = 12_000;

/**
 * Read a public JSON blob by exact pathname.
 * Pathnames are stable (put uses addRandomSuffix: false). Avoids list() on every GET.
 */
export async function readJsonBlob(pathname, fallback) {
  const now = Date.now();
  const hit = mem.get(pathname);
  if (hit && now - hit.at < TTL_MS) return hit.data;
  try {
    const info = await head(pathname);
    const url = info && info.url;
    if (!url) {
      mem.set(pathname, { at: now, data: fallback });
      return fallback;
    }
    const r = await fetch(url);
    if (!r.ok) {
      mem.set(pathname, { at: now, data: fallback });
      return fallback;
    }
    const data = await r.json();
    mem.set(pathname, { at: now, data });
    return data;
  } catch {
    mem.set(pathname, { at: now, data: fallback });
    return fallback;
  }
}

export function rememberJsonBlob(pathname, data) {
  mem.set(pathname, { at: Date.now(), data });
}
