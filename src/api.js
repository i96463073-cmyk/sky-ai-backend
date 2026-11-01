import { SYMBOLS, TIMEFRAMES } from "./market/symbols.js";
import { getMarketData, assessFreshness, providerState } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";
import { ENGINE_VERSION } from "./smc/config.js";

export const API_VERSION = "signals-api-0.2.3";

const HEADERS = {
  "Content-Type": "application/json; charset=UTF-8",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

const reply = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });
const fail = (status, code, message) => reply({ ok: false, error: { code, message } }, status);

export async function handleApi(request, env = {}) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: HEADERS });
  
  const url = new URL(request.url);

  if (url.pathname === "/api/signals" || url.pathname === "/api/live") {
    if (!env.SKY_MEMORY) return fail(500, "NO_DB", "Database not configured");
    
    // 🟢 1 READ: Fetch everything from one single key
    const appStateStr = await env.SKY_MEMORY.get("app_state") || '{"pending":[],"completed":[],"news":[]}';
    const appState = JSON.parse(appStateStr);
    
    const pendingRaw = appState.pending || [];
    const completed = appState.completed || [];
    const news = appState.news || [];
    
    // 2. Filter out trades older than 12 hours
    const now = Date.now();
    const pending = pendingRaw.filter(sig => {
      const timeStr = sig.created_at || sig.time;
      if (!timeStr) return true; 
      const ageMs = now - new Date(timeStr).getTime();
      return ageMs < (12 * 60 * 60 * 1000); 
    });
    
    // 3. Sort newest first
    pending.sort((a, b) => (b.created_at || "").localeCompare(a.created_at || ""));
    completed.sort((a, b) => (b.closed_at || "").localeCompare(a.closed_at || ""));

    // 🟢 0 READS: Fetch live prices from Cache
    let live_prices = {};
    const cache = caches.default;
    const cacheKey = new Request("https://sky-ai-backend.i96463073.workers.dev/api/prices-cache", { method: "GET" });
    
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) {
      live_prices = await cachedResponse.json();
    } else {
      live_prices = JSON.parse(await env.SKY_MEMORY.get("live_prices") || "{}");
    }

    // 4. Return the exact format the app expects
    return reply({ ok: true, live_prices, pending, completed, news });
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
