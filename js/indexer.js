/**
 * Arena client indexer (window.ArenaIndex).
 *
 * Instant fills: Bluefin AssetSwap on each Instadex pool (transactions where
 * affectedObject = bluefin_pool_id). Do not scan global AssetSwap.
 * Curve leftovers: P::events::TradeEvent + ClaimEvent (kind=0 reflection, kind=1 pit).
 * LaunchEvent.quote / index.pools[id].quote → SUI or XAUM (gold quote type is XAUM).
 * toCandles(trades, intervalMs) → TVBar { time: unix ms, open, high, low, close, volume }.
 * volume on candles is mist (1e9); the token page converts with fromMist for TV.
 *
 * packageId unset → demo TradeEvents so the chart still has candles.
 *
 * Instant is Pool<T,Q> (coin A = token, B = quote). a2b false = buy, true = sell.
 * Curve quote fee is 1% (100 bps). Gold quote type is XAUM.
 */
(function (root) {
  "use strict";

  var XAUM_TYPE =
    "0x9d297676e7a4b771ab023291377b2adfaa4938fb9080b8d12430e4b108b836a9::xaum::XAUM";
  var SUI_TYPE = "0x2::sui::SUI";
  var CLAIM_REFLECTION = 0;
  var CLAIM_PIT = 1;
  var MIST = 1e9;
  var DEFAULT_RPC = "https://fullnode.mainnet.sui.io:443";
  var BLUEFIN_ORIGIN =
    "0x3492c874c1e3b3e2984e8c41b589e642d4d0a5d6459e5a9cfc2d52fd7c89c267";
  var BLUEFIN_ASSET_SWAP = BLUEFIN_ORIGIN + "::events::AssetSwap";
  var DEMO_WALLET = "0x8f2a00000000000000000000000000000000000000000000000000000000ab71";
  var ADDRS = [
    DEMO_WALLET,
    "0xa91c00000000000000000000000000000000000000000000000000000000d012",
    "0x11c000000000000000000000000000000000000000000000000000000000012f",
    "0x70bb000000000000000000000000000000000000000000000000000000004410",
    "0xcc8100000000000000000000000000000000000000000000000000000000e203",
    "0x5d0e00000000000000000000000000000000000000000000000000000000c801",
    "0x09ae000000000000000000000000000000000000000000000000000000003290",
    "0xbb2100000000000000000000000000000000000000000000000000000000aa13",
  ];

  function quoteLabel(quote) {
    if (!quote) return "SUI";
    var s = String(quote);
    if (s === "XAUM" || s === XAUM_TYPE || /xaum/i.test(s)) return "XAUM";
    return "SUI";
  }

  function fromMist(s) {
    var n = Number(s);
    return isFinite(n) ? n / MIST : 0;
  }

  function toMist(n) {
    return Math.max(0, Math.round(Number(n) * MIST));
  }

  function num(v) {
    var n = Number(v);
    return isFinite(n) ? n : 0;
  }

  /** Bonding-curve price in quote/token (same 9-dec units cancel). */
  function tradePrice(t) {
    if (!t) return 0;
    if (t.price != null && isFinite(t.price) && t.price > 0) return Number(t.price);
    var qr = num(t.quote_real);
    var tr = num(t.token_reserve);
    if (qr > 0 && tr > 0) return qr / tr;
    var q = num(t.quote_amount);
    var tok = num(t.token_amount);
    if (q > 0 && tok > 0) return q / tok;
    return 0;
  }

  /**
   * Aggregate TradeEvents into TVBar candles.
   * time = unix ms bucket start. volume = mist (quote_amount).
   */
  function toCandles(trades, intervalMs) {
    var bucket = intervalMs > 0 ? intervalMs : 60 * 1000;
    var map = {};
    var list = (trades || []).slice().sort(function (a, b) {
      return num(a.ts || a.timestampMs) - num(b.ts || b.timestampMs);
    });
    for (var i = 0; i < list.length; i++) {
      var t = list[i];
      var ts = num(t.ts || t.timestampMs || t.time);
      if (ts > 0 && ts < 1e12) ts = ts * 1000;
      var px = tradePrice(t);
      var vol = num(t.quote_amount);
      if (!ts || !(px > 0)) continue;
      var bt = Math.floor(ts / bucket) * bucket;
      var b = map[bt];
      if (!b) {
        map[bt] = { time: bt, open: px, high: px, low: px, close: px, volume: vol };
      } else {
        b.high = Math.max(b.high, px);
        b.low = Math.min(b.low, px);
        b.close = px;
        b.volume += vol;
      }
    }
    return Object.keys(map)
      .map(function (k) { return map[k]; })
      .sort(function (a, b) { return a.time - b.time; });
  }

  function seedOf(s) {
    var n = 0;
    s = String(s || "");
    for (var i = 0; i < s.length; i++) n = (n * 33 + s.charCodeAt(i)) >>> 0;
    return n;
  }

  var FEE_BPS = 100;
  var REFL_BPS = { reflection: 50, creator: 20, pit: 20, platform: 10 };
  var NON_REFL_BPS = { reflection: 0, creator: 60, pit: 30, platform: 10 };

  function mistStr(v) {
    if (v == null || v === "") return "0";
    return String(v);
  }

  function asTrade(raw) {
    raw = raw || {};
    var ts = num(raw.ts || raw.timestampMs || raw.time) || Date.now();
    if (ts > 0 && ts < 1e12) ts = ts * 1000;
    var out = {
      pool_id: String(raw.pool_id || raw.poolId || raw.symbol || raw.token || ""),
      trader: String(raw.trader || DEMO_WALLET),
      is_buy: !!(raw.is_buy || raw.isBuy),
      quote_amount: mistStr(raw.quote_amount),
      token_amount: mistStr(raw.token_amount),
      pit_fee: mistStr(raw.pit_fee),
      reflection_fee: mistStr(raw.reflection_fee),
      creator_fee: mistStr(raw.creator_fee),
      platform_fee: mistStr(raw.platform_fee),
      raised: mistStr(raw.raised),
      token_reserve: mistStr(raw.token_reserve),
      quote_real: mistStr(raw.quote_real),
      ts: ts,
      timestampMs: ts
    };
    if (raw.price != null && isFinite(Number(raw.price))) out.price = Number(raw.price);
    return out;
  }

  function makeTrade(opts) {
    opts = opts || {};
    var ts = opts.ts || Date.now();
    var price = opts.price > 0 ? opts.price : 4.65e-6;
    var quoteHuman = opts.quote != null ? Number(opts.quote) : 1;
    var quote_amount = toMist(quoteHuman);
    var token_amount = Math.max(1, Math.round(quote_amount / price));
    var reflOn = !!opts.reflection;
    var split = reflOn ? REFL_BPS : NON_REFL_BPS;
    var pit_fee = Math.round(quote_amount * split.pit / 10000);
    var reflection_fee = Math.round(quote_amount * split.reflection / 10000);
    var creator_fee = Math.round(quote_amount * split.creator / 10000);
    var platform_fee = Math.round(quote_amount * split.platform / 10000);
    var quote_real = opts.quote_real != null ? toMist(opts.quote_real) : quote_amount;
    var token_reserve = opts.token_reserve != null
      ? (typeof opts.token_reserve === "string" ? num(opts.token_reserve) : toMist(opts.token_reserve))
      : Math.max(1, Math.round(quote_real / price));
    var raised = opts.raised != null ? toMist(opts.raised) : quote_real;
    return asTrade({
      pool_id: opts.pool_id,
      trader: opts.trader,
      is_buy: opts.is_buy,
      quote_amount: String(quote_amount),
      token_amount: String(token_amount),
      pit_fee: String(pit_fee),
      reflection_fee: String(reflection_fee),
      creator_fee: String(creator_fee),
      platform_fee: String(platform_fee),
      raised: String(raised),
      token_reserve: String(token_reserve),
      quote_real: String(quote_real),
      price: price,
      ts: ts
    });
  }

  function tokenQuote(tk) {
    if (!tk) return "SUI";
    return quoteLabel(tk.q || tk.quote || "SUI");
  }

  function isHolders(tk) {
    return !!(tk && tk.mode === "Holders");
  }

  function basePrice(tk) {
    if (!tk) return 4.65e-6;
    if (tokenQuote(tk) === "XAUM") return 6.2e-10 * (1 + (seedOf(tk.t) % 9) * 0.08);
    return 4.65e-6 * (1 + (seedOf(tk.t) % 17) * 0.035);
  }

  /**
   * Historical TradeEvents for demo tokens. pool_id = ticker so the page can filter.
   */
  function generateDemoHistory(tokens) {
    var now = Date.now();
    var trades = [];
    var launches = [];
    (tokens || []).forEach(function (tk, ti) {
      var seed = seedOf(tk.t);
      var price = basePrice(tk);
      var count = 280 + (seed % 40);
      var raisedHuman = Math.max(8, (tk.cap || 100) * 0.36);
      var gold = tokenQuote(tk) === "XAUM";
      launches.push({
        pool_id: tk.t,
        token: tk.t,
        quote: gold ? XAUM_TYPE : SUI_TYPE,
        creator: ADDRS[ti % ADDRS.length],
        pit_mode: isHolders(tk) ? 0 : 1,
        reflection: isHolders(tk),
        name: tk.n,
        symbol: tk.t,
      });
      for (var i = count; i >= 0; i--) {
        var ts = now - i * 22 * 1000 - (seed % 17) * 1000;
        var wave = Math.sin((count - i + seed) * 0.19) * 0.011;
        var isBuy = ((seed + i * 3) % 10) > 2;
        price = Math.max(price * 0.15, price * (1 + (isBuy ? 1 : -1) * (0.003 + Math.abs(wave)) + wave * 0.15));
        var quoteHuman = gold
          ? 0.008 + ((seed * 11 + i * 19) % 180) / 10000
          : 0.35 + ((seed * 13 + i * 17) % 1800) / 100;
        raisedHuman += isBuy ? quoteHuman : 0;
        trades.push(makeTrade({
          pool_id: tk.t,
          trader: ADDRS[(seed + i) % ADDRS.length],
          is_buy: isBuy,
          quote: quoteHuman,
          price: price,
          reflection: isHolders(tk),
          raised: raisedHuman,
          quote_real: raisedHuman,
          ts: ts,
        }));
      }
    });
    trades.sort(function (a, b) { return a.ts - b.ts; });
    return { trades: trades, launches: launches };
  }

  function generateDemoLive(tokens, now) {
    tokens = tokens || [];
    if (!tokens.length) return null;
    var tk = tokens[Math.floor(Math.random() * tokens.length)];
    var gold = tokenQuote(tk) === "XAUM";
    var isBuy = Math.random() > 0.32;
    var quoteHuman = gold ? 0.01 + Math.random() * 0.08 : 0.4 + Math.random() * 18;
    var px = basePrice(tk) * (1 + (Math.random() - 0.4) * 0.08);
    return makeTrade({
      pool_id: tk.t,
      trader: ADDRS[Math.floor(Math.random() * ADDRS.length)],
      is_buy: isBuy,
      quote: quoteHuman,
      price: px,
      reflection: isHolders(tk),
      raised: Math.max(8, (tk.cap || 100) * 0.42),
      quote_real: Math.max(8, (tk.cap || 100) * 0.36),
      ts: now || Date.now(),
    });
  }

  function demoSnapshot(tokens, wallet) {
    wallet = wallet || DEMO_WALLET;
    var pools = {};
    (tokens || []).forEach(function (tk) {
      if (!isHolders(tk)) return;
      var q = tokenQuote(tk);
      var unpaid = q === "XAUM" ? "420000000" : "1250000000";
      var claimed = q === "XAUM" ? "80000000" : "400000000";
      var holders = {};
      holders[wallet] = {
        poolId: tk.t,
        address: wallet,
        registered: "1000000000000",
        unpaidReflection: unpaid,
        claimedReflection: claimed,
        updatedMs: Date.now(),
      };
      pools[tk.t] = {
        quote: q,
        reflection: true,
        holders: holders,
        totalReflectionFees: "5000000000",
        totalClaimed: claimed,
      };
    });
    return { pools: pools, cursor: null };
  }

  function rpcCall(rpc, method, params) {
    return fetch(rpc, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: method, params: params }),
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.error) throw new Error(j.error.message || "rpc error");
      return j.result;
    });
  }

  var DEFAULT_GQL = "https://graphql.mainnet.sui.io/graphql";

  function queryEventsGql(gql, type, cursor, limit) {
    var q = "query($t:String!,$first:Int!,$after:String){ events(first:$first, after:$after, filter:{ type:$t }){ pageInfo { hasNextPage endCursor } nodes { timestamp sender { address } contents { json } transaction { digest } } } }";
    return fetch(gql || DEFAULT_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: q, variables: { t: type, first: limit || 50, after: cursor || null } })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql");
      var conn = (j.data && j.data.events) || {};
      var nodes = conn.nodes || [];
      var info = conn.pageInfo || {};
      return {
        data: nodes.map(function (n) {
          return {
            parsedJson: (n.contents && n.contents.json) || {},
            timestampMs: Date.parse(n.timestamp) || Date.now(),
            sender: n.sender && n.sender.address,
            id: { txDigest: n.transaction && n.transaction.digest }
          };
        }),
        hasNextPage: !!info.hasNextPage,
        nextCursor: info.endCursor || null
      };
    });
  }

  function queryEvents(rpc, type, cursor, limit) {
    var gql = (typeof window !== "undefined" && window.SUI_GRAPHQL) || DEFAULT_GQL;
    return queryEventsGql(gql, type, cursor, limit).catch(function () {
      return rpcCall(rpc, "suix_queryEvents", [
        { MoveEventType: type },
        cursor || null,
        limit || 50,
        false,
      ]).then(function (res) {
        return res || { data: [], hasNextPage: false, nextCursor: null };
      });
    });
  }

  function isAssetSwapType(t) {
    return /::events::AssetSwap$/i.test(String(t || ""));
  }

  function normId(id) {
    return String(id || "").toLowerCase();
  }

  /**
   * Instant is Pool<T,Q>: coin A = token, coin B = quote.
   * a2b false = quote in / token out (buy). a2b true = token in / quote out (sell).
   * Hop AssetSwaps in the same tx have a different pool_id — drop them.
   */
  function parseAssetSwap(ev, poolId) {
    var p = (ev && ev.parsedJson) || {};
    var pid = String(p.pool_id || "");
    if (poolId && normId(pid) !== normId(poolId)) return null;
    if (!pid) return null;
    var isBuy = !p.a2b;
    var amountIn = mistStr(p.amount_in);
    var amountOut = mistStr(p.amount_out);
    var tokenAmt = isBuy ? amountOut : amountIn;
    var quoteAmt = isBuy ? amountIn : amountOut;
    var tokenRes = mistStr(p.pool_coin_a_amount);
    var quoteRes = mistStr(p.pool_coin_b_amount);
    var digest = (ev.id && (ev.id.txDigest || ev.id.tx_digest)) || ev.digest || "";
    var out = asTrade({
      pool_id: pid,
      trader: ev.sender || "",
      is_buy: isBuy,
      quote_amount: quoteAmt,
      token_amount: tokenAmt,
      pit_fee: "0",
      reflection_fee: "0",
      creator_fee: "0",
      platform_fee: "0",
      raised: quoteRes,
      token_reserve: tokenRes,
      quote_real: quoteRes,
      ts: num(ev.timestampMs) || Date.now()
    });
    out.bluefin = true;
    out.a2b = !!p.a2b;
    out.fee = mistStr(p.fee);
    out.digest = String(digest || "");
    out.seq = mistStr(p.sequence_number);
    var tok = num(tokenAmt);
    var qAmt = num(quoteAmt);
    if (tok > 0 && qAmt > 0) out.price = qAmt / tok;
    return out;
  }

  function queryPoolTxsGql(gql, poolId, before, limit) {
    var q =
      "query($o:SuiAddress!,$last:Int!,$before:String){ transactions(last:$last, before:$before, filter:{ affectedObject:$o }){ pageInfo { hasPreviousPage startCursor } nodes { digest sender { address } effects { timestamp events(first: 40) { nodes { timestamp sender { address } contents { type { repr } json } } } } } } }";
    return fetch(gql || DEFAULT_GQL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: q,
        variables: { o: poolId, last: limit || 50, before: before || null }
      })
    }).then(function (r) { return r.json(); }).then(function (j) {
      if (j.errors && j.errors.length) throw new Error(j.errors[0].message || "graphql");
      var conn = (j.data && j.data.transactions) || {};
      var nodes = conn.nodes || [];
      var info = conn.pageInfo || {};
      var data = [];
      for (var i = 0; i < nodes.length; i++) {
        var n = nodes[i];
        var effects = n.effects || {};
        var evs = (effects.events && effects.events.nodes) || [];
        var ts = Date.parse(effects.timestamp) || Date.now();
        var sender = n.sender && n.sender.address;
        for (var k = 0; k < evs.length; k++) {
          var e = evs[k];
          data.push({
            parsedJson: (e.contents && e.contents.json) || {},
            timestampMs: Date.parse(e.timestamp) || ts,
            sender: sender,
            digest: n.digest,
            id: { txDigest: n.digest },
            type: (e.contents && e.contents.type && e.contents.type.repr) || ""
          });
        }
      }
      return {
        data: data,
        hasNextPage: !!info.hasPreviousPage,
        nextCursor: info.startCursor || null
      };
    });
  }

  function collectPoolSwaps(gql, poolId, pages, limit) {
    var out = [];
    var cursor = null;
    var n = pages || 1;
    function step(i) {
      if (i >= n) return Promise.resolve(out);
      return queryPoolTxsGql(gql, poolId, cursor, limit || 50).then(function (page) {
        var rows = page.data || [];
        for (var j = 0; j < rows.length; j++) {
          if (!isAssetSwapType(rows[j].type) && rows[j].type !== BLUEFIN_ASSET_SWAP) continue;
          var t = parseAssetSwap(rows[j], poolId);
          if (t) out.push(t);
        }
        if (!page.hasNextPage || !page.nextCursor) return out;
        cursor = page.nextCursor;
        return step(i + 1);
      });
    }
    return step(0);
  }

  function parseTrade(ev) {
    var p = ev.parsedJson || {};
    return asTrade({
      pool_id: p.pool_id,
      trader: p.trader || ev.sender,
      is_buy: p.is_buy,
      quote_amount: p.quote_amount,
      token_amount: p.token_amount,
      pit_fee: p.pit_fee,
      reflection_fee: p.reflection_fee,
      creator_fee: p.creator_fee,
      platform_fee: p.platform_fee,
      raised: p.raised,
      token_reserve: p.token_reserve,
      quote_real: p.quote_real,
      ts: num(ev.timestampMs) || Date.now()
    });
  }

  function parseClaim(ev) {
    var p = ev.parsedJson || {};
    return {
      pool_id: String(p.pool_id || ""),
      who: String(p.who || ""),
      amount: String(p.amount || "0"),
      kind: num(p.kind),
      ts: num(ev.timestampMs),
    };
  }

  function parseLaunch(ev) {
    var p = ev.parsedJson || {};
    return {
      pool_id: String(p.pool_id || ""),
      token: p.token,
      quote: p.quote,
      creator: String(p.creator || ""),
      pit_mode: num(p.pit_mode),
      reflection: !!p.reflection,
      name: p.name,
      symbol: p.symbol || "",
      virtual_quote: p.virtual_quote,
      virtual_token: p.virtual_token,
    };
  }

  function parseGraduation(ev) {
    var p = ev.parsedJson || {};
    return {
      pool_id: String(p.pool_id || ""),
      raised: p.raised,
      token_reserve: p.token_reserve,
      quote_real: p.quote_real,
      ts: num(ev.timestampMs) || Date.now()
    };
  }

  function parseLock(ev) {
    var p = ev.parsedJson || {};
    return {
      lock_id: String(p.lock_id || ""),
      pool_id: String(p.pool_id || ""),
      beneficiary: String(p.beneficiary || ""),
      unlock_ms: num(p.unlock_ms),
      token_amount: p.token_amount,
      quote_amount: p.quote_amount,
      ts: num(ev.timestampMs) || Date.now()
    };
  }

  function parseBluefinLock(ev) {
    var p = ev.parsedJson || {};
    return {
      lock_id: String(p.lock_id || ""),
      pool_id: String(p.pool_id || ""),
      beneficiary: String(p.beneficiary || ""),
      unlock_ms: num(p.unlock_ms),
      token_amount: p.token_amount,
      quote_amount: p.quote_amount,
      bluefin_pool_id: String(p.bluefin_pool_id || ""),
      position_id: String(p.position_id || ""),
      ts: num(ev.timestampMs) || Date.now()
    };
  }

  function typeNameOf(v) {
    if (v == null || v === "") return "";
    if (typeof v === "string") return v;
    if (typeof v === "object") {
      if (v.address && v.module) return String(v.address) + "::" + v.module + "::" + (v.name || "");
      if (v.name && String(v.name).indexOf("::") >= 0) return String(v.name);
      if (v.name) return String(v.name);
    }
    return String(v);
  }

  /**
   * InstadexLaunchEvent — no Arena pool_id. unlock_ms 0 = permanent lock.
   * quoteLabel maps quote TypeName to SUI / XAUM. Missing event types are ignored by collect().
   */
  function parseInstadexLaunch(ev) {
    var p = ev.parsedJson || {};
    var unlock = num(p.unlock_ms);
    var quoteRaw = p.quote;
    return {
      lock_id: String(p.lock_id || ""),
      bluefin_pool_id: String(p.bluefin_pool_id || ""),
      position_id: String(p.position_id || ""),
      token: p.token,
      quote: quoteRaw,
      quoteLabel: quoteLabel(typeNameOf(quoteRaw) || quoteRaw),
      creator: String(p.creator || ev.sender || ""),
      token_amount: p.token_amount,
      quote_amount: p.quote_amount,
      unlock_ms: unlock,
      permanent: unlock === 0,
      name: p.name,
      symbol: p.symbol || "",
      instadex: true,
      ts: num(ev.timestampMs) || Date.now()
    };
  }

  function parseInstadexBurn(ev) {
    var p = ev.parsedJson || {};
    return {
      lock_id: String(p.lock_id || ""),
      amount: p.amount,
      ts: num(ev.timestampMs) || Date.now()
    };
  }

  function parseInstadexMintLock(ev) {
    var p = ev.parsedJson || {};
    return {
      lock_id: String(p.lock_id || ""),
      mint_lock_id: String(p.mint_lock_id || ""),
      ts: num(ev.timestampMs) || Date.now()
    };
  }

  async function collect(rpc, type, parse, pages, limit) {
    var out = [];
    var cursor = null;
    for (var i = 0; i < (pages || 8); i++) {
      var page = await queryEvents(rpc, type, cursor, limit || 50);
      var data = page.data || [];
      if (!data.length) break;
      for (var j = 0; j < data.length; j++) out.push(parse(data[j]));
      if (!page.hasNextPage || !page.nextCursor) break;
      cursor = page.nextCursor;
    }
    return out;
  }

  /**
   * subscribe({ packageId, callPackage, instadexPackages, lockPackages, rpc, tokens, live, demoMs, onTrade, onLaunch, onInstadex })
   * InstadexLaunchEvent originated on v4 (callPackage / ARENA_INSTADEX_PACKAGE). Query that package.
   * Instant fills: watchBluefinPool(bluefin_pool_id) → AssetSwap for that pool only.
   * Curve leftovers still collect TradeEvent once.
   * Fires onInstadex, or onLaunch with instadex:true if that callback is omitted.
   * Missing event types are ignored.
   * Returns { trades, claims, push, refreshInstadex, watchBluefinPool, refreshBluefin, stop }.
   */
  function subscribe(opts) {
    opts = opts || {};
    var trades = [];
    var claims = [];
    var timer = null;
    var instaTimer = null;
    var bluefinTimer = null;
    var refreshInstadex = function () {};
    var seenTrades = {};
    var bluefinPools = {};
    var gql = (typeof window !== "undefined" && window.SUI_GRAPHQL) || DEFAULT_GQL;

    function tradeKey(ev) {
      if (ev.digest) return String(ev.digest) + ":" + String(ev.seq || "") + ":" + normId(ev.pool_id);
      return String(ev.ts || "") + ":" + String(ev.pool_id || "") + ":" + String(ev.trader || "") + ":" + String(ev.token_amount || "") + ":" + String(ev.is_buy ? 1 : 0);
    }

    function push(ev) {
      if (!ev) return ev;
      var key = tradeKey(ev);
      if (seenTrades[key]) return ev;
      seenTrades[key] = 1;
      trades.push(ev);
      if (opts.onTrade) opts.onTrade(ev);
      return ev;
    }

    function pullBluefinPool(poolId) {
      poolId = String(poolId || "");
      var id = normId(poolId);
      if (!id || id === "0x0") return Promise.resolve();
      var rec = bluefinPools[id];
      if (!rec) {
        rec = { pulling: false };
        bluefinPools[id] = rec;
      }
      if (rec.pulling) return Promise.resolve();
      rec.pulling = true;
      return collectPoolSwaps(gql, poolId, 1, 50).then(function (rows) {
        rec.pulling = false;
        (rows || []).forEach(function (t) { push(t); });
      }).catch(function () { rec.pulling = false; });
    }

    function watchBluefinPool(poolId) {
      poolId = String(poolId || "");
      var id = normId(poolId);
      if (!id || id === "0x0") return;
      var first = !bluefinPools[id];
      if (first) bluefinPools[id] = { pulling: false };
      if (first) pullBluefinPool(poolId);
    }

    function refreshBluefin(poolId) {
      if (poolId) return pullBluefinPool(poolId);
      return Promise.all(Object.keys(bluefinPools).map(function (id) { return pullBluefinPool(id); }));
    }

    if (!opts.packageId) {
      var hist = generateDemoHistory(opts.tokens || []);
      hist.trades.forEach(function (t) { trades.push(t); });
      (hist.launches || []).forEach(function (l) {
        if (opts.onLaunch) opts.onLaunch(l);
      });
      if (opts.live) {
        timer = setInterval(function () {
          push(generateDemoLive(opts.tokens, Date.now()));
        }, opts.demoMs || 1000);
      }
    } else {
      var rpc = opts.rpc || DEFAULT_RPC;
      var P = opts.packageId;
      collect(rpc, P + "::events::TradeEvent", parseTrade, 8, 50).then(function (rows) {
        rows.forEach(function (t) { push(t); });
      }).catch(function () {});
      collect(rpc, P + "::events::ClaimEvent", parseClaim, 4, 50).then(function (rows) {
        rows.forEach(function (c) { claims.push(c); });
      }).catch(function () {});
      collect(rpc, P + "::events::LaunchEvent", parseLaunch, 2, 50).then(function (rows) {
        rows.forEach(function (l) { if (opts.onLaunch) opts.onLaunch(l); });
      }).catch(function () {});
      collect(rpc, P + "::events::GraduationEvent", parseGraduation, 2, 50).then(function (rows) {
        rows.forEach(function (g) { if (opts.onGraduate) opts.onGraduate(g); });
      }).catch(function () {});
      collect(rpc, P + "::events::LockEvent", parseLock, 2, 50).then(function (rows) {
        rows.forEach(function (g) { if (opts.onLock) opts.onLock(g); });
      }).catch(function () {});
      var lockPkgs = (opts.lockPackages || []).slice();
      if (lockPkgs.indexOf(P) < 0) lockPkgs.push(P);
      var callPkg = opts.callPackage || opts.instadexPackage;
      if (typeof window !== "undefined") {
        callPkg = callPkg || window.ARENA_INSTADEX_PACKAGE || window.ARENA_CALL_PACKAGE;
      }
      if (callPkg && lockPkgs.indexOf(callPkg) < 0) lockPkgs.push(callPkg);
      lockPkgs.forEach(function (LP) {
        if (!LP || LP === "0x0") return;
        collect(rpc, LP + "::events::BluefinLockEvent", parseBluefinLock, 2, 50).then(function (rows) {
          rows.forEach(function (g) { if (opts.onBluefinLock) opts.onBluefinLock(g); });
        }).catch(function () {});
      });
      function emitInstadex(l) {
        if (l && l.bluefin_pool_id) watchBluefinPool(l.bluefin_pool_id);
        if (opts.onInstadex) opts.onInstadex(l);
        else if (opts.onLaunch) opts.onLaunch(l);
      }
      function pullInstadex(pkg) {
        if (!pkg || pkg === "0x0") return;
        collect(rpc, pkg + "::events::InstadexLaunchEvent", parseInstadexLaunch, 2, 50).then(function (rows) {
          rows.forEach(emitInstadex);
        }).catch(function () {});
      }
      var instadexPkgs = (opts.instadexPackages || []).slice();
      if (callPkg && instadexPkgs.indexOf(callPkg) < 0) instadexPkgs.push(callPkg);
      // InstadexLaunchEvent type origin is v4. Do not rely on original package P (0x5cfd).
      if (!instadexPkgs.length) instadexPkgs.push(P);
      instadexPkgs.forEach(pullInstadex);
      refreshInstadex = function () { instadexPkgs.forEach(pullInstadex); };
      function emitBurn(b) {
        if (opts.onInstadexBurn) opts.onInstadexBurn(b);
      }
      function pullBurn(pkg) {
        if (!pkg || pkg === "0x0") return;
        collect(rpc, pkg + "::events::InstadexBurnEvent", parseInstadexBurn, 2, 50).then(function (rows) {
          rows.forEach(emitBurn);
        }).catch(function () {});
      }
      function emitMintLock(m) {
        if (opts.onInstadexMintLock) opts.onInstadexMintLock(m);
      }
      function pullMintLock(pkg) {
        if (!pkg || pkg === "0x0") return;
        collect(rpc, pkg + "::events::InstadexMintLockEvent", parseInstadexMintLock, 2, 50).then(function (rows) {
          rows.forEach(emitMintLock);
        }).catch(function () {});
      }
      var burnPkgs = (opts.burnPackages || []).slice();
      if (typeof window !== "undefined") {
        var bp = window.ARENA_COLLECT_PACKAGE || window.ARENA_CALL_PACKAGE;
        if (bp && burnPkgs.indexOf(bp) < 0) burnPkgs.push(bp);
      }
      burnPkgs.forEach(pullBurn);
      var mintPkgs = (opts.mintLockPackages || burnPkgs).slice();
      mintPkgs.forEach(pullMintLock);
      if (opts.live) {
        instaTimer = setInterval(refreshInstadex, opts.instadexMs || 12000);
        setInterval(function () { burnPkgs.forEach(pullBurn); mintPkgs.forEach(pullMintLock); }, opts.instadexMs || 12000);
        bluefinTimer = setInterval(function () { refreshBluefin(); }, opts.bluefinMs || 8000);
      }
    }

    return {
      trades: trades,
      claims: claims,
      push: push,
      refreshInstadex: refreshInstadex,
      watchBluefinPool: watchBluefinPool,
      refreshBluefin: refreshBluefin,
      stop: function () {
        if (timer) { clearInterval(timer); timer = null; }
        if (instaTimer) { clearInterval(instaTimer); instaTimer = null; }
        if (bluefinTimer) { clearInterval(bluefinTimer); bluefinTimer = null; }
      },
    };
  }

  async function loadSnapshot(url) {
    if (!url) return null;
    var res = await fetch(url, { cache: "no-store" });
    if (!res.ok) throw new Error("snapshot " + res.status);
    return res.json();
  }

  async function loadIndex(url) {
    if (!url) return { index: null };
    var index = await loadSnapshot(url);
    return { index: index };
  }

  function holderQuote(index, poolId, address) {
    if (!index || !index.pools) return null;
    var rec = index.pools[poolId];
    if (!rec) return null;
    var holders = rec.holders || {};
    var h = address ? (holders[address] || holders[String(address).toLowerCase()]) : null;
    if (!h) {
      var keys = Object.keys(holders);
      h = keys.length ? holders[keys[0]] : null;
    }
    return {
      quote: quoteLabel(rec.quote),
      reflection: !!rec.reflection,
      unpaid: h ? h.unpaidReflection : "0",
      claimed: h ? h.claimedReflection : "0",
      unpaidHuman: fromMist(h && h.unpaidReflection),
      claimedHuman: fromMist(h && h.claimedReflection),
      holder: h || null,
    };
  }

  var api = {
    XAUM_TYPE: XAUM_TYPE,
    SUI_TYPE: SUI_TYPE,
    CLAIM_REFLECTION: CLAIM_REFLECTION,
    CLAIM_PIT: CLAIM_PIT,
    DEMO_WALLET: DEMO_WALLET,
    quoteLabel: quoteLabel,
    fromMist: fromMist,
    toMist: toMist,
    tradePrice: tradePrice,
    toCandles: toCandles,
    asTrade: asTrade,
    makeTrade: makeTrade,
    FEE_BPS: FEE_BPS,
    REFL_BPS: REFL_BPS,
    NON_REFL_BPS: NON_REFL_BPS,
    generateDemoHistory: generateDemoHistory,
    generateDemoLive: generateDemoLive,
    demoTrades: function (opts) {
      opts = opts || {};
      var tk = { t: opts.ticker || "VOLT", n: opts.ticker || "VOLT", cap: 465, mode: "Holders", q: "SUI" };
      return generateDemoHistory([tk]).trades;
    },
    demoSnapshot: demoSnapshot,
    parseGraduation: parseGraduation,
    parseLock: parseLock,
    parseBluefinLock: parseBluefinLock,
    parseInstadexLaunch: parseInstadexLaunch,
    parseInstadexBurn: parseInstadexBurn,
    parseInstadexMintLock: parseInstadexMintLock,
    parseAssetSwap: parseAssetSwap,
    BLUEFIN_ASSET_SWAP: BLUEFIN_ASSET_SWAP,
    subscribe: subscribe,
    loadSnapshot: loadSnapshot,
    loadIndex: loadIndex,
    holderQuote: holderQuote,
    queryEvents: queryEvents,
  };

  root.ArenaIndex = api;
  root.ArenaIndexer = api;
})(typeof window !== "undefined" ? window : globalThis);
