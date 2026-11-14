import { SYMBOLS, TIMEFRAMES } from "./market/symbols.js";
import { getMarketData, assessFreshness, isMarketClosed } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";
import { ENGINE_VERSION, getClosedCandles, getSignal } from "./engine.js";

export const API_VERSION = "signals-api-0.5.0";

// "Signals today" counter. Must match the engine's daily target and day boundary (EAT).
const DAILY_TARGET = 3;
const DAY_TZ = "Africa/Nairobi";
function dayKey(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: DAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

const MIN_CLOSED_CANDLES = 30;

// Set an ALLOWED_ORIGIN variable (e.g. https://your-dashboard.pages.dev) to stop other
// websites from reading your signals. If it is not set, any site can read them ("*").
function corsHeaders(env) {
  return {
    "Content-Type": "application/json; charset=UTF-8",
    "Access-Control-Allow-Origin": env?.ALLOWED_ORIGIN || "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Vary": "Origin"
  };
}

// Every pair in market/symbols.js (same list the cron job scans).
const LIVE_SYMBOLS = Object.keys(SYMBOLS);

// Fetches the newest M15 candle close for every pair straight from the market-data
// connector (which caches for 60s per Worker instance and de-duplicates requests).
// Never invents prices: if nothing can be fetched it falls back to the last stored
// values and says so in prices_meta.status.
async function getLivePrices(env) {
  const now = Date.now();

  const rows = await Promise.all(
    LIVE_SYMBOLS.map(async (symbol) => {
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
  const HEADERS = corsHeaders(env);
  const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
  const fail = (status, code, message) => reply({ ok: false, error: { code, message } }, status);

  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });

  const url = new URL(request.url);

  if (url.pathname === "/api/signals" || url.pathname === "/api/live") {
    if (!env.SKY_MEMORY) return fail(500, "NO_DB", "Database not configured");

    // 1 KV READ: everything stored by the cron job lives in one key.
    // A corrupt value must not take the dashboard down, so parsing is guarded.
    let appState = {};
    try {
      appState = JSON.parse((await env.SKY_MEMORY.get("app_state")) || "{}") || {};
    } catch (e) {
      console.error("Corrupt app_state in /api/signals:", e);
    }

    const pendingRaw = Array.isArray(appState.pending) ? appState.pending : [];
    const completed = Array.isArray(appState.completed) ? appState.completed : [];
    const news = Array.isArray(appState.news) ? appState.news : [];

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

    const dk = dayKey(now);
    const daily = { date: dk, count: Number(appState.tracker?.daily?.[dk] ?? 0), target: DAILY_TARGET };

    return reply({
      ok: true,
      api_version: API_VERSION,
      engine_version: ENGINE_VERSION,
      daily,
      live_prices,
      prices_meta,
      pending,
      completed,
      news
    });
  }

  // Chart data for the app (same payload as /test-signal, but always public so you can lock /test-* with ADMIN_KEY).
  if (url.pathname === "/api/chart") {
    const symbol = String(url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
    const tfKey = String(url.searchParams.get("timeframe") || url.searchParams.get("tf") || "M15").toUpperCase();
    if (!SYMBOLS[symbol] || !TIMEFRAMES[tfKey]) return fail(400, "BAD_PARAMS", "Invalid symbol or timeframe");
    try {
      return reply(await getSignal(env, symbol, tfKey));
    } catch (e) {
      return fail(500, "CHART_FAIL", String(e?.message || e));
    }
  }

  if (url.pathname === "/api/analysis") {
    const symbol = String(url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
    const tfKey = String(url.searchParams.get("tf") || "M15").toUpperCase();
    if (!SYMBOLS[symbol] || !TIMEFRAMES[tfKey]) return fail(400, "BAD_PARAMS", "Invalid symbol or timeframe");

    const data = await getMarketData(env, symbol, tfKey, 300);
    if (!data || !data.ok) return fail(502, "DATA_FAIL", "Data fetch failed");

    // Use CLOSED candles only, exactly like the signal engine, so charts match the signals.
    const closed = getClosedCandles(data.candles);
    if (closed.length < MIN_CLOSED_CANDLES) {
      return fail(422, "NOT_ENOUGH_DATA", `Only ${closed.length} closed candles available; need ${MIN_CLOSED_CANDLES}.`);
    }

    const result = analyze(closed, tfKey);
    if (!result.ok) return fail(422, result.code, result.message);

    return reply({ ok: true, engine_version: ENGINE_VERSION, symbol, timeframe: tfKey, analysis: result });
  }

  return fail(404, "NOT_FOUND", "Unknown API route");
}
