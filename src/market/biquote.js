// Biquote market-data connector: fetch, validate, normalize, cache.
// Never fabricates data: any failure is returned as an explicit error.
//
// Observed response shape (owner's browser, 2026-10-26):
// {"symbol":"XAUUSD","interval":"15m","bars":[{"openTime":"2026-10-26T07:15:00Z",
//  "open":..,"high":..,"low":..,"close":..,"volume":0,"tickVolume":782,"isOpen":true}, ...]}
// Bars arrived newest-first; we sort ourselves. "volume" is 0 and is ignored;
// "tickVolume" is provider-supplied tick count, NOT exchange volume.

import { SYMBOLS, TIMEFRAMES } from "./symbols.js";

const DEFAULT_BASE = "https://biquote.io/api";
const TIMEOUT_MS = 8000;
const MAX_ATTEMPTS = 3;
const MAX_REPORTED_REJECTS = 10;
const TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

export class ProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.code = code;
    Object.assign(this, extra);
  }
}

// Approximate FX/metals weekly closure in UTC: Fri 21:00 -> Sun 22:00.
// (Real close times shift by an hour with daylight saving; this is deliberately wide.)
export function isMarketClosed(ms) {
  const d = new Date(ms);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  return day === 6 || (day === 5 && hour >= 21) || (day === 0 && hour < 22);
}

export function validateBar(raw, tf) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { reason: "not an object" };
  if (typeof raw.openTime !== "string" || !TS_RE.test(raw.openTime)) return { reason: "bad openTime format" };
  const time = Date.parse(raw.openTime);
  if (!Number.isFinite(time)) return { reason: "bad openTime value" };
  if (tf.ms <= 3600000 && time % tf.ms !== 0) return { reason: "openTime not aligned to interval" };

  const { open: o, high: h, low: l, close: c } = raw;
  for (const v of [o, h, l, c]) {
    if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return { reason: "OHLC not positive finite numbers" };
  }
  if (h < Math.max(o, c, l)) return { reason: "high below open/close/low" };
  if (l > Math.min(o, c, h)) return { reason: "low above open/close/high" };
  if (typeof raw.isOpen !== "boolean") return { reason: "missing isOpen flag" };

  let tickVolume = null;
  if (raw.tickVolume !== undefined && raw.tickVolume !== null) {
    if (typeof raw.tickVolume !== "number" || !Number.isFinite(raw.tickVolume) || raw.tickVolume < 0)
      return { reason: "bad tickVolume" };
    tickVolume = raw.tickVolume;
  }
  return {
    candle: {
      time,
      iso: new Date(time).toISOString(),
      open: o,
      high: h,
      low: l,
      close: c,
      tickVolume,
      closed: !raw.isOpen
    }
  };
}

export function findGaps(candles, stepMs) {
  const gaps = [];
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].time - candles[i - 1].time;
    if (delta <= stepMs) continue;
    const missing = Math.round(delta / stepMs) - 1;
    let expected = true;
    for (let k = 1; k <= Math.min(missing, 2000); k++) {
      if (!isMarketClosed(candles[i - 1].time + k * stepMs)) {
        expected = false;
        break;
      }
    }
    gaps.push({ from: candles[i - 1].iso, to: candles[i].iso, missing, expected });
  }
  return gaps;
}

export function normalizeBars(payload, symbolKey, tfKey) {
  const tf = TIMEFRAMES[tfKey];
  const providerSymbol = SYMBOLS[symbolKey]?.providerSymbol;
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !Array.isArray(payload.bars))
    return { ok: false, error: { code: "MALFORMED_RESPONSE", message: "Provider response has no bars array" } };
  if (typeof payload.symbol === "string" && payload.symbol.toUpperCase() !== providerSymbol)
    return { ok: false, error: { code: "UNEXPECTED_SYMBOL", message: "Provider returned a different symbol" } };
  if (typeof payload.interval === "string" && payload.interval !== tf.interval)
    return { ok: false, error: { code: "UNEXPECTED_INTERVAL", message: "Provider returned a different interval" } };
  if (payload.bars.length === 0)
    return { ok: false, error: { code: "NO_DATA", message: "Provider returned no candles" } };

  const byTime = new Map();
  const rejected = [];
  let rejectedCount = 0;
  let duplicatesRemoved = 0;
  payload.bars.forEach((raw, index) => {
    const r = validateBar(raw, tf);
    if (!r.candle) {
      rejectedCount++;
      if (rejected.length < MAX_REPORTED_REJECTS) rejected.push({ index, reason: r.reason });
      return;
    }
    if (byTime.has(r.candle.time)) duplicatesRemoved++;
    byTime.set(r.candle.time, r.candle);
  });
  if (byTime.size === 0)
    return { ok: false, error: { code: "ALL_CANDLES_REJECTED", message: "Every candle failed validation" } };

  const candles = [...byTime.values()].sort((a, b) => a.time - b.time);
  const warnings = [];
  for (let i = 0; i < candles.length - 1; i++) {
    if (!candles[i].closed) {
      warnings.push("An older candle is still flagged as forming");
      break;
    }
  }
  return {
    ok: true,
    candles,
    received: payload.bars.length,
    rejectedCount,
    rejected,
    duplicatesRemoved,
    gaps: findGaps(candles, tf.ms),
    warnings
  };
}

// Freshness of the newest candle relative to "now".
// stale = market should be open but the newest candle opened more than 2 intervals ago.
export function assessFreshness(candles, tfKey, nowMs) {
  if (!candles || candles.length === 0) return { status: "no_data" };
  const tf = TIMEFRAMES[tfKey];
  const last = candles[candles.length - 1];
  const ageMs = nowMs - last.time;
  if (isMarketClosed(nowMs)) return { status: "market_closed", ageMs, latestCandleTime: last.iso };
  return { status: ageMs <= tf.ms * 2 ? "fresh" : "stale", ageMs, latestCandleTime: last.iso };
}

// ---------- network layer ----------

function parseRetryAfter(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 300) : null;
}

async function requestOnce(fetchImpl, url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, headers: { accept: "application/json" } });
    if (response.status === 429)
      throw new ProviderError("RATE_LIMITED", "Market-data provider rate limit reached", {
        retryAfter: parseRetryAfter(response.headers.get("retry-after"))
      });
    if (!response.ok)
      throw new ProviderError("HTTP_ERROR", "Market-data provider returned HTTP " + response.status, {
        status: response.status,
        retryable: response.status >= 500
      });
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      throw new ProviderError("BAD_JSON", "Market-data provider returned invalid JSON");
    }
  } catch (e) {
    if (e instanceof ProviderError) throw e;
    if (e && e.name === "AbortError") throw new ProviderError("TIMEOUT", "Market-data request timed out", { retryable: true });
    throw new ProviderError("NETWORK", "Could not reach the market-data provider", { retryable: true });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(fetchImpl, url, sleep) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await requestOnce(fetchImpl, url);
    } catch (e) {
      if (!(e instanceof ProviderError) || !e.retryable || attempt >= MAX_ATTEMPTS) throw e;
      await sleep(300 * attempt);
    }
  }
}

// ---------- cache, de-duplication, status ----------
// Per-Worker-instance memory only. It resets when the Worker restarts.

const cache = new Map();
const inflight = new Map();
const lastSuccessByKey = new Map();
export const providerState = { lastSuccessAt: null, lastError: null };

export function _resetForTests() {
  cache.clear();
  inflight.clear();
  lastSuccessByKey.clear();
  providerState.lastSuccessAt = null;
  providerState.lastError = null;
}

export async function getMarketData(env, symbolKey, tfKey, limit, deps = {}) {
  const fetchImpl = deps.fetchImpl || ((...a) => globalThis.fetch(...a));
  const now = deps.now || Date.now;
  const sleep = deps.sleep || (ms => new Promise(r => setTimeout(r, ms)));
  const tf = TIMEFRAMES[tfKey];
  const key = symbolKey + "|" + tfKey + "|" + limit;
  const ttl = Math.min(60000, Math.max(15000, tf.ms / 10));

  const hit = cache.get(key);
  if (hit && now() - hit.at < ttl) return { ...hit.value, cached: true };
  if (inflight.has(key)) return inflight.get(key);

  const base = String((env && env.BIQUOTE_BASE_URL) || DEFAULT_BASE).replace(/\/+$/, "");
  const url =
    base + "/" + encodeURIComponent(SYMBOLS[symbolKey].providerSymbol) +
    "/ohlc?interval=" + encodeURIComponent(tf.interval) + "&limit=" + limit;

  const load = async () => {
    try {
      const payload = await fetchWithRetry(fetchImpl, url, sleep);
      const norm = normalizeBars(payload, symbolKey, tfKey);
      if (!norm.ok) throw new ProviderError(norm.error.code, norm.error.message);
      const fetchedAt = now();
      providerState.lastSuccessAt = fetchedAt;
      providerState.lastError = null;
      lastSuccessByKey.set(key, fetchedAt);
      const value = {
        ok: true,
        provider: "Biquote",
        symbol: symbolKey,
        timeframe: tfKey,
        interval: tf.interval,
        fetchedAt,
        cached: false,
        candles: norm.candles,
        quality: {
          received: norm.received,
          accepted: norm.candles.length,
          rejectedCount: norm.rejectedCount,
          rejected: norm.rejected,
          duplicatesRemoved: norm.duplicatesRemoved,
          gaps: norm.gaps,
          unexpectedGaps: norm.gaps.filter(g => !g.expected).length,
          warnings: norm.warnings
        }
      };
      cache.set(key, { at: fetchedAt, value });
      return value;
    } catch (e) {
      const err = e instanceof ProviderError ? e : new ProviderError("INTERNAL", "Unexpected connector error");
      providerState.lastError = { code: err.code, message: err.message, at: now() };
      return {
        ok: false,
        provider: "Biquote",
        error: { code: err.code, message: err.message, retryAfter: err.retryAfter ?? null },
        lastSuccessfulUpdate: lastSuccessByKey.get(key) ?? null
      };
    }
  };

  const p = load().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
