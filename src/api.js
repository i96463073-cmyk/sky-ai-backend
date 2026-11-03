import { SYMBOLS, TIMEFRAMES } from "./market/symbols.js";
import { getMarketData, assessFreshness, providerState, isMarketClosed } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";
import { ENGINE_VERSION } from "./smc/config.js";

export const API_VERSION = "signals-api-0.3.0";

const HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status, code, message) => reply({ ok: false, error: { code, message } }, status);

// Same pairs the cron job scans.
const LIVE_SYMBOLS = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF", "AUDUSD", "NZDUSD"];

// Fetches the newest M15 candle close for every pair straight from the market-data
// connector (which caches for 60s per Worker instance and de-duplicates requests).
// Never invents prices: if nothing can be fetched it falls back to the last stored
// values and says so in prices_meta.status.
async function getLivePrices(env) {
  const now = Date.now();

  const rows = await Promise.all(
    LIVE_SYMBOLS.filter((s) => SYMBOLS[s]).map(async (symbol) => {
      try {
        const d = await getMarketData(env, symbol, "M15", 1);
        if (!d || !d.ok || !d.candles || d.candles.length === 0) return { symbol, ok: false };
        const last = d.candles[d.candles.length - 1];
        return {
          symbol,
          ok: true,
          price: last.close,
          fetchedAt: d.fetchedAt,
          freshness: assessFreshness(d.candles, "M15", now).status,
        };
      } catch (e) {
        return { symbol, ok: false };
      }
    })
  );

  const prices = {};
  const missing = [];
  let newest = 0;
  let anyStale = false;
  for (const r of rows) {
    if (!r.ok) {
      missing.push(r.symbol);
      continue;
    }
    prices[r.symbol] = r.price;
    if (r.fetchedAt > newest) newest = r.fetchedAt;
    if (r.freshness === "stale") anyStale = true;
  }

  if (Object.keys(prices).length > 0) {
    const status = isMarketClosed(now) ? "market_closed" : anyStale ? "stale" : "fresh";
    return {
      prices,
      meta: {
        source: "biquote",
        status,
        updated_at: new Date(newest).toISOString(),
        age_seconds: Math.max(0, Math.round((now - newest) / 1000)),
        missing,
      },
    };
  }

  // Fallback 1: price cache written by the cron job (only visible in the same data centre).
  try {
    const cached = await caches.default.match(
      new Request("https://sky-ai-backend.i96463073.workers.dev/api/prices-cache", { method: "GET" })
    );
    if (cached) {
      const p = await cached.json();
      if (p && Object.keys(p).length > 0) {
        return { prices: p, meta: { source: "fallback-cache", status: "stale", updated_at: null, age_seconds: null, missing: LIVE_SYMBOLS } };
      }
    }
  } catch (e) {}

  // Fallback 2: old KV value (may be very old; flagged stale).
  try {
    const kv = JSON.parse((await env.SKY_MEMORY.get("live_prices")) || "{}");
    if (kv && Object.keys(kv).length > 0) {
      return { prices: kv, meta: { source: "fallback-kv", status: "stale", updated_at: null, age_seconds: null, missing: LIVE_SYMBOLS } };
    }
  } catch (e) {}

  return { prices: {}, meta: { source: "none", status: "unavailable", updated_at: null, age_seconds: null, missing: LIVE_SYMBOLS } };
}

export async function handleApi(request, env = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const url = new URL(request.url);

  if (url.pathname === "/api/signals" || url.pathname === "/api/live") {
    if (!env.SKY_MEMORY) return fail(500, "NO_DB", "Database not configured");

    // 1 KV READ: everything stored by the cron job lives in one key
    const appStateStr = (await env.SKY_MEMORY.get("app_state")) || '{"pending":[],"completed":[],"news":[]}';
    const appState = JSON.parse(appStateStr);

    const pendingRaw = appState.pending || [];
    const completed = appState.completed || [];
    const news = appState.news || [];

    // Filter out trades older than 12 hours
    const now = Date.now();
    const pending = pendingRaw.filter((sig) => {
      const timeStr = sig.created_at || sig.time;
      if (!timeStr) return true;
      const ageMs = now - new Date(timeStr).getTime();
      return ageMs < 12 * 60 * 60 * 1000;
    });

    // Sort newest first
    pending.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    completed.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));

    // Fresh prices (max ~60s old) plus an honest freshness report
    const { prices: live_prices, meta: prices_meta } = await getLivePrices(env);

    return reply({ ok: true, live_prices, prices_meta, pending, completed, news });
  }

  if (url.pathname === "/api/analysis") {
    const symbol = String(url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
    const tfKey = String(url.searchParams.get("tf") || "M15").toUpperCase();
    if (!SYMBOLS[symbol] || !TIMEFRAMES[tfKey]) return fail(400, "BAD_PARAMS", "Invalid symbol or timeframe");

    const data = await getMarketData(env, symbol, tfKey, 300);
    if (!data.ok) return fail(502, "DATA_FAIL", "Data fetch failed");

    const result = analyze(data.candles, tfKey);
    if (!result.ok) return fail(422, result.code, result.message);

    return reply({ ok: true, symbol, timeframe: tfKey, analysis: result });
  }

  return fail(404, "NOT_FOUND", "Unknown API route");
}
