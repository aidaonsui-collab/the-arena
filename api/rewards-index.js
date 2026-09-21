import { put } from "@vercel/blob";
import { readJsonBlob, rememberJsonBlob } from "./_blob-json.js";

/**
 * Incrementally indexes basket_yield::push_payout events into a
 * wallet -> {asset: rawAmount} map, so /api/rewards-lookup can
 * answer instantly instead of every client re-walking the whole event
 * history (which, at Sui's hard 50-events-per-page ceiling with no
 * server-side filter by recipient, took 5+ minutes for an active holder —
 * see index.html history around the live wallet-lookup feature).
 *
 * A BasketYieldPushEvent's type is pinned to whichever package published
 * events.move at call time, not the package that calls push_payout, and not
 * the ARENA_BASKET_YIELD_EVENT_PACKAGE constant either — this list mirrors
 * api/og.js EVENT_PKGS (confirmed directly against a real transaction's
 * emitted events, not assumed).
 */
const EVENT_PKGS = [
  "0xcf7835ae4e3f8a3d4eb4bd9d14cb4a3dbdd80e70908feb6c433688a31e119de3",
  "0xd8531cc8c4e1ee914f0e4e48aea9a796faa0603459cc4665838f688e51bf23d9",
  "0x1c808e5fe7f14703a72cae3cd71ebba98b3a9a97dc530feed6222595bfb4a853",
  "0x3ccc57531949d6f24178bd57fe20496ee4ff515e26c280f1b80f658bc020bcbe",
];
const VICEFUN_REWARDS_VAULT = "0x3b8a61405825146ee68f351363f29a3e4206683fced840ea10cdfba50fe075e7";
const GQL = process.env.SUI_GRAPHQL || "https://graphql.mainnet.sui.io/graphql";
const BLOB_PATH = "rewards-index/vicefun.json";
const QUERY =
  "query($type: String!, $first: Int!, $after: String) { events(filter: { type: $type }, first: $first, after: $after) { pageInfo { hasNextPage endCursor } nodes { contents { json } } } }";
// Stay well under the function's execution limit and resume next run —
// cursors are saved after every page, so an interrupted run loses no
// progress. A cold index needs several runs to catch up to "now"; after
// that each run is a handful of near-empty pages.
const MAX_MS = 45_000;

function authOk(request) {
  const secret = process.env.CRON_SECRET || process.env.ARENA_SETTLE_SECRET || "";
  if (!secret) return !process.env.VERCEL;
  const raw = request.headers.get("authorization") || "";
  return raw === "Bearer " + secret;
}

function normAddr(a) {
  a = String(a || "").trim().toLowerCase();
  if (!a) return "";
  if (!a.startsWith("0x")) a = "0x" + a;
  const hex = a.slice(2).replace(/^0+/, "") || "0";
  return "0x" + hex.padStart(64, "0");
}

async function fetchPageOnce(type, after) {
  const r = await fetch(GQL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ query: QUERY, variables: { type, first: 50, after } }),
    cache: "no-store",
  });
  const j = await r.json();
  if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql error");
  return j.data.events;
}

// A page that fails once and is silently skipped stops that package's walk
// at whatever cursor it had — indistinguishable, from the outside, from
// genuinely having reached the end of history. That already happened once
// here in testing (a single transient failure made a run report "ok" after
// covering a fraction of real history). Retry before giving up, and track
// which packages actually reached hasNextPage:false versus which ones
// merely stopped, so that distinction survives into the response instead of
// being flattened into an unqualified "ok: true".
async function fetchPage(type, after) {
  let lastErr = null;
  for (let attempt = 0; attempt < 6; attempt++) {
    try {
      return await fetchPageOnce(type, after);
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastErr || new Error("events query failed");
}

export async function GET(request) {
  if (!authOk(request)) return Response.json({ error: "unauthorized" }, { status: 401 });

  const state = (await readJsonBlob(BLOB_PATH, null)) || { wallets: {}, cursors: {}, updatedMs: 0 };
  if (!state.wallets) state.wallets = {};
  if (!state.cursors) state.cursors = {};

  const t0 = Date.now();
  let pagesDone = 0;
  let eventsMatched = 0;
  const perPkg = {};
  const stalled = [];

  for (const pkg of EVENT_PKGS) {
    const type = pkg + "::events::BasketYieldPushEvent";
    let cursor = state.cursors[pkg] || null;
    let pkgPages = 0;
    let caughtUp = false;
    for (;;) {
      if (Date.now() - t0 > MAX_MS) break;
      let page;
      try {
        page = await fetchPage(type, cursor);
      } catch (e) {
        // Retries inside fetchPage already ran out. Leave the cursor where
        // it is — the next run retries from exactly here — and record that
        // this package did not reach the real end this pass, rather than
        // letting the loop's normal exit look identical to actually
        // catching up.
        stalled.push({ pkg, at: cursor, error: e && e.message ? e.message : String(e) });
        break;
      }
      pagesDone++;
      pkgPages++;
      for (const n of page.nodes || []) {
        const j = (n && n.contents && n.contents.json) || {};
        if (normAddr(j.basket_id) !== VICEFUN_REWARDS_VAULT) continue;
        const addr = normAddr(j.recipient);
        const asset = typeof j.asset === "string" ? j.asset : "";
        if (!addr || !asset) continue;
        let amount;
        try {
          amount = BigInt(String(j.amount || "0"));
        } catch {
          continue;
        }
        const w = state.wallets[addr] || (state.wallets[addr] = {});
        const prev = w[asset] ? BigInt(w[asset]) : 0n;
        w[asset] = String(prev + amount);
        eventsMatched++;
      }
      if (page.pageInfo && page.pageInfo.endCursor) {
        cursor = page.pageInfo.endCursor;
        state.cursors[pkg] = cursor;
      }
      if (!page.pageInfo || !page.pageInfo.hasNextPage) {
        caughtUp = true;
        break;
      }
      if (Date.now() - t0 > MAX_MS) break;
    }
    perPkg[pkg] = { pages: pkgPages, caughtUp };
    if (Date.now() - t0 > MAX_MS) break;
  }

  state.updatedMs = Date.now();
  try {
    await put(BLOB_PATH, JSON.stringify(state), {
      access: "public",
      addRandomSuffix: false,
      allowOverwrite: true,
      contentType: "application/json",
      // 0, not the 15s several other blobs in this project use for read-heavy
      // fan-out: this one gets read-then-written by the *next* indexer run
      // (every 5 min in production, but back-to-back when re-triggered
      // manually for backfill/testing), and a stale CDN read there means
      // building on top of already-superseded state instead of the write
      // that just happened.
      cacheControlMaxAge: 0,
    });
    rememberJsonBlob(BLOB_PATH, state);
  } catch (e) {
    const why = e && e.message ? String(e.message) : "blob put failed";
    return Response.json({ error: why.slice(0, 180) }, { status: 502 });
  }

  return Response.json({
    ok: true,
    pagesDone,
    eventsMatched,
    perPkg,
    stalled,
    wallets: Object.keys(state.wallets).length,
    tookMs: Date.now() - t0,
    updatedMs: state.updatedMs,
  });
}
