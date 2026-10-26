// Public, read-only SKY AI SIGNALS API (analysis only; no trading, no broker access).

import { SYMBOLS, TIMEFRAMES } from "./market/symbols.js";
import { getMarketData, assessFreshness, providerState } from "./market/biquote.js";

export const API_VERSION = "signals-api-0.1.0";
const MAX_LIMIT = 300;

const HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store"
};

const reply = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...HEADERS, ...extra } });
const fail = (status, code, message, extra) => reply({ ok: false, error: { code, message } }, status, extra);
const iso = ms => (ms ? new Date(ms).toISOString() : null);

export async function handleApi(request, env = {}, deps = {}) {
  const now = deps.now || Date.now;
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  if (request.method !== "GET")
    return fail(405, "METHOD_NOT_ALLOWED", "Only GET is supported", { Allow: "GET, OPTIONS" });

  const url = new URL(request.url);
  if (url.pathname === "/api/health") return health(env, now);
  if (url.pathname === "/api/market") return market(url, env, deps, now);
  return fail(404, "NOT_FOUND", "Unknown API route");
}

function health(env, now) {
  const err = providerState.lastError;
  return reply({
    ok: true,
    service: "SKY AI SIGNALS",
    version: API_VERSION,
    mode: "analysis-only",
    tradeExecution: false,
    provider: {
      name: "Biquote",
      lastSuccessfulUpdate: iso(providerState.lastSuccessAt),
      lastError: err ? { code: err.code, message: err.message, at: iso(err.at) } : null,
      note: "Per-instance status; resets when the Worker restarts"
    },
    supported: {
      symbols: Object.keys(SYMBOLS),
      timeframes: Object.fromEntries(
        Object.entries(TIMEFRAMES).map(([k, v]) => [k, { interval: v.interval, verifiedByOwner: v.verified }])
      )
    },
    storage: { d1: Boolean(env && env.DB) },
    now: iso(now())
  });
}

async function market(url, env, deps, now) {
  const symbol = String(url.searchParams.get("symbol") || "XAUUSD").toUpperCase();
  const tfKey = String(url.searchParams.get("tf") || "M15").toUpperCase();
  const rawLimit = url.searchParams.get("limit");
  const limit = rawLimit === null ? 100 : Number(rawLimit);

  if (!SYMBOLS[symbol]) return fail(400, "UNSUPPORTED_SYMBOL", "Unsupported symbol. Use one of: " + Object.keys(SYMBOLS).join(", "));
  if (!TIMEFRAMES[tfKey]) return fail(400, "UNSUPPORTED_TIMEFRAME", "Unsupported timeframe. Use one of: " + Object.keys(TIMEFRAMES).join(", "));
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT)
    return fail(400, "BAD_LIMIT", "limit must be a whole number from 1 to " + MAX_LIMIT);

  // Bucketed upstream sizes keep the number of distinct provider requests small.
  const bucket = limit <= 100 ? 100 : MAX_LIMIT;
  const data = await getMarketData(env, symbol, tfKey, bucket, deps);

  if (!data.ok) {
    const status = data.error.code === "RATE_LIMITED" ? 503 : 502;
    const extra = data.error.retryAfter ? { "Retry-After": String(data.error.retryAfter) } : {};
    return reply(
      {
        ok: false,
        provider: "Biquote",
        symbol,
        timeframe: tfKey,
        error: { code: data.error.code, message: data.error.message },
        lastSuccessfulUpdate: iso(data.lastSuccessfulUpdate),
        note: "No candles are shown because live data could not be loaded."
      },
      status,
      extra
    );
  }

  const shown = data.candles.slice(-limit);
  const last = data.candles[data.candles.length - 1];
  const lastClosed = [...data.candles].reverse().find(c => c.closed) || null;
  return reply({
    ok: true,
    provider: "Biquote",
    symbol,
    name: SYMBOLS[symbol].name,
    timeframe: tfKey,
    interval: data.interval,
    intervalVerifiedByOwner: TIMEFRAMES[tfKey].verified,
    fetchedAt: iso(data.fetchedAt),
    lastSuccessfulUpdate: iso(data.fetchedAt),
    cached: data.cached,
    freshness: assessFreshness(data.candles, tfKey, now()),
    latest: {
      time: last.iso,
      close: last.close,
      closed: last.closed,
      note: "Close of the newest candle; not a live bid/ask quote"
    },
    latestClosed: lastClosed && { time: lastClosed.iso, close: lastClosed.close },
    quality: data.quality,
    volumeNote: "tickVolume is a provider-supplied tick count, not centralized exchange volume",
    candles: shown.map(c => ({ t: c.iso, o: c.open, h: c.high, l: c.low, c: c.close, tickVolume: c.tickVolume, closed: c.closed }))
  });
}
