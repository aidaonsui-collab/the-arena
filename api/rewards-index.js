import { put } from "@vercel/blob";
import { readJsonBlob, rememberJsonBlob } from "./_blob-json.js";
import { keeperAuthOk } from "./_keeper-auth.js";

/**
 * Blob store for the holder-rewards index. The walk itself runs on Jessica's
 * Air (keepers index-rewards). This route only reads or replaces that blob.
 * A Vercel cron used to walk Sui here for up to 45s every 5 minutes.
 */
const BLOB_PATH = "rewards-index/vicefun.json";

export async function GET(request) {
  if (!keeperAuthOk(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const state = (await readJsonBlob(BLOB_PATH, null)) || { wallets: {}, cursors: {}, updatedMs: 0 };
  const url = new URL(request.url);
  if (url.searchParams.get("dump") === "1") {
    return Response.json(state, { headers: { "cache-control": "no-store" } });
  }
  return Response.json({
    ok: true,
    idle: true,
    wallets: Object.keys(state.wallets || {}).length,
    updatedMs: state.updatedMs || 0,
  });
}

export async function POST(request) {
  if (!keeperAuthOk(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid json" }, { status: 400 });
  }
  const state = {
    wallets: body && body.wallets && typeof body.wallets === "object" ? body.wallets : {},
    cursors: body && body.cursors && typeof body.cursors === "object" ? body.cursors : {},
    updatedMs: Date.now(),
  };
  try {
    await put(BLOB_PATH, JSON.stringify(state), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      cacheControlMaxAge: 0,
    });
    rememberJsonBlob(BLOB_PATH, state);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return Response.json({ error: why.slice(0, 180) }, { status: 502 });
  }
  return Response.json({
    ok: true,
    wallets: Object.keys(state.wallets).length,
    updatedMs: state.updatedMs,
  });
}
