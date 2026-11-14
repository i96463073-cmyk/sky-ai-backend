// ============================================
// SKY AI — Agent
//   1. News filter  : economic-calendar check (no AI needed, so it is fast and reliable)
//   2. App chat     : answers the chat tab using your live signal data
//   3. runAgent     : your original AI + web-search news check (kept, bugs fixed)
// ============================================

const DEFAULT_GEMINI = ["gemini-2.5-flash", "gemini-1.5-flash"];
const DEFAULT_GROQ = ["openai/gpt-oss-20b", "openai/gpt-oss-120b"];
const DEFAULT_CF = ["@cf/meta/llama-3.1-8b-instruct", "@cf/meta/llama-3.3-70b-instruct-fp8-fast"];
// If a model name is ever retired you can change it without editing code:
// set GEMINI_MODELS / GROQ_MODELS / CF_MODELS as comma-separated variables.

// Free ForexFactory calendar mirror. Rate-limited, so we cache it for an hour in KV.
const CALENDAR_URL = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
const CALENDAR_KEY = "calendar_cache";
const CALENDAR_TTL_MS = 60 * 60 * 1000;
const CALENDAR_RETRY_MS = 10 * 60 * 1000;   // after a failed fetch, wait before trying again

const DISPLAY_TZ = "Africa/Nairobi";
const DAILY_TARGET = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function json(data, headers, status = 200) {
  return new Response(JSON.stringify(data), { status, headers });
}

function getKeys(plural, singular) {
  const raw = String(plural || "").trim();
  if (raw) return [...new Set(raw.split(",").map((k) => k.trim()).filter(Boolean))];
  return singular ? [String(singular).trim()].filter(Boolean) : [];
}

const listFrom = (value, fallback) => {
  const items = String(value || "").split(",").map((s) => s.trim()).filter(Boolean);
  return items.length ? items : fallback;
};

async function fetchWithTimeout(url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

function eatLabel(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: DISPLAY_TZ, weekday: "short", day: "2-digit", month: "short",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return `${p.weekday} ${p.day} ${p.month} ${p.hour}:${p.minute} EAT`;
}

function dayKey(ms) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: DISPLAY_TZ, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(new Date(ms)).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}`;
}

// ============================================
// 1. ECONOMIC CALENDAR NEWS FILTER
// ============================================
function normalizeEvents(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((e) => ({
      title: String(e?.title ?? "").trim(),
      currency: String(e?.country ?? e?.currency ?? "").trim().toUpperCase(),
      impact: String(e?.impact ?? "").trim(),
      timeMs: Date.parse(e?.date),
      forecast: String(e?.forecast ?? ""),
      previous: String(e?.previous ?? "")
    }))
    .filter((e) => e.title && Number.isFinite(e.timeMs));
}

/** Returns { events, source: "live" | "cache" | "stale-cache" | "unavailable", fetchedAt } and never throws. */
export async function getCalendar(env) {
  const now = Date.now();
  let cached = null;
  try {
    const raw = await env.SKY_MEMORY?.get(CALENDAR_KEY);
    if (raw) cached = JSON.parse(raw);
  } catch (_) { /* ignore */ }

  const haveEvents = Array.isArray(cached?.events) && cached.events.length > 0;
  if (haveEvents && now - Number(cached.fetchedAt || 0) < CALENDAR_TTL_MS) {
    return { events: cached.events, source: "cache", fetchedAt: cached.fetchedAt };
  }
  // Recently failed: don't hammer the free feed, use whatever we have.
  if (Number(cached?.nextTry || 0) > now) {
    return haveEvents
      ? { events: cached.events, source: "stale-cache", fetchedAt: cached.fetchedAt }
      : { events: [], source: "unavailable", fetchedAt: null };
  }

  try {
    const res = await fetchWithTimeout(CALENDAR_URL, {
      headers: { "User-Agent": "Mozilla/5.0 (SkyAI)", "Accept": "application/json" }
    }, 8000);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const events = normalizeEvents(await res.json());
    if (!events.length) throw new Error("empty calendar");
    try { await env.SKY_MEMORY?.put(CALENDAR_KEY, JSON.stringify({ fetchedAt: now, events })); } catch (_) {}
    return { events, source: "live", fetchedAt: now };
  } catch (e) {
    console.error("Calendar fetch failed:", e?.message || e);
    try {
      await env.SKY_MEMORY?.put(CALENDAR_KEY, JSON.stringify({
        fetchedAt: cached?.fetchedAt ?? 0, events: cached?.events ?? [], nextTry: now + CALENDAR_RETRY_MS
      }));
    } catch (_) {}
    return haveEvents
      ? { events: cached.events, source: "stale-cache", fetchedAt: cached.fetchedAt }
      : { events: [], source: "unavailable", fetchedAt: null };
  }
}

/** Currencies a pair is exposed to. Gold (XAU) is driven by USD news. */
export function symbolCurrencies(symbol) {
  const s = String(symbol || "").toUpperCase();
  return [s.slice(0, 3), s.slice(3, 6)].filter((c) => c && c !== "XAU");
}

/** Blocks a pair when a high-impact event for either currency is close (before or after). */
export function newsCheck(events, symbol, nowMs, opts = {}) {
  const before = (opts.beforeMin ?? 30) * 60000;
  const after = (opts.afterMin ?? 30) * 60000;
  const currencies = symbolCurrencies(symbol);
  const hit = (events || [])
    .filter((e) => e.impact === "High" && currencies.includes(e.currency) &&
      e.timeMs - nowMs <= before && nowMs - e.timeMs <= after)
    .sort((a, b) => a.timeMs - b.timeMs)[0];
  if (!hit) return { block: false };
  const mins = Math.round((hit.timeMs - nowMs) / 60000);
  const when = mins >= 0 ? `in ${mins} min` : `${-mins} min ago`;
  return { block: true, reason: `${hit.currency} ${hit.title} ${when}`, event: hit };
}

/** High-impact events in the next `hours`, formatted for the app's news list. */
export function upcomingNews(events, nowMs, hours = 24, limit = 8) {
  return (events || [])
    .filter((e) => e.impact === "High" && e.timeMs >= nowMs - 30 * 60000 && e.timeMs <= nowMs + hours * 3600000)
    .sort((a, b) => a.timeMs - b.timeMs)
    .slice(0, limit)
    .map((e) => ({
      title: e.title,
      currency: e.currency,
      impact: "High",
      time: eatLabel(e.timeMs),
      source: "ForexFactory"
    }));
}

// ============================================
// AI PROVIDERS (Gemini → Groq → Cloudflare)
// ============================================
async function openAiStyleChat(url, key, models, req) {
  for (const model of models) {
    try {
      const body = {
        model,
        messages: req.messages,
        temperature: req.temperature ?? 0.1,
        max_tokens: req.maxTokens ?? 1000
      };
      if (req.tools) body.tools = req.tools;
      const response = await fetchWithTimeout(url, {
        method: "POST",
        headers: { "Authorization": "Bearer " + key, "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) continue;
      const data = await response.json();
      if (data.choices?.[0]?.message) return { ok: true, message: data.choices[0].message };
    } catch (_) { /* try next model */ }
  }
  return { ok: false };
}

async function callAI(env, req) {
  const gModels = listFrom(env.GEMINI_MODELS, DEFAULT_GEMINI);
  for (const key of getKeys(env.GEMINI_API_KEYS, env.GEMINI_API_KEY)) {
    const r = await openAiStyleChat("https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", key, gModels, req);
    if (r.ok) return { ...r, provider: "gemini" };
  }

  const groqModels = listFrom(env.GROQ_MODELS, DEFAULT_GROQ);
  for (const key of getKeys(env.GROQ_API_KEYS, env.GROQ_API_KEY)) {
    const r = await openAiStyleChat("https://api.groq.com/openai/v1/chat/completions", key, groqModels, req);
    if (r.ok) return { ...r, provider: "groq" };
  }

  if (env.AI) {
    for (const model of listFrom(env.CF_MODELS, DEFAULT_CF)) {
      try {
        const response = await env.AI.run(model, { messages: req.messages, tools: req.tools });
        if (response?.response) return { ok: true, provider: "cloudflare", message: { role: "assistant", content: response.response } };
      } catch (_) { /* try next model */ }
    }
  }
  return { ok: false, error: "All AI providers failed" };
}

// ============================================
// 2. APP CHAT
// ============================================
async function readState(env) {
  try {
    return JSON.parse((await env.SKY_MEMORY.get("app_state")) || "{}") || {};
  } catch (_) {
    return {};
  }
}

function digitsFor(symbol) {
  const s = String(symbol || "").toUpperCase();
  if (s.startsWith("XAU")) return 2;
  if (s.endsWith("JPY")) return 3;
  return 5;
}

async function buildChatContext(env) {
  const state = await readState(env);
  const now = Date.now();
  const lines = [];

  const pending = Array.isArray(state.pending) ? state.pending : [];
  lines.push("CURRENT SETUPS:");
  if (!pending.length) lines.push("- none (the engine is waiting for a quality setup)");
  for (const t of pending.slice(0, 10)) {
    const d = digitsFor(t.symbol);
    const phase = t.watch ? "watchlist, not entered" : t.entered ? "ACTIVE trade" : "waiting for entry";
    const tps = (t.take_profit || []).map((x) => Number(x).toFixed(d)).join(", ");
    lines.push(`- ${t.symbol} ${t.direction} ${t.timeframe} [${phase}] grade ${t.quality || "?"}, ` +
      `entry ${Number(t.entry).toFixed(d)}, SL ${Number(t.stop_loss).toFixed(d)}, TP ${tps}` +
      (t.tp_hit ? `, TP${t.tp_hit} hit` : ""));
  }

  const completed = Array.isArray(state.completed) ? state.completed : [];
  const wins = completed.filter((t) => t.result === "WIN").length;
  const losses = completed.filter((t) => t.result === "LOSS").length;
  const netR = completed.reduce((sum, t) => sum + (Number(t.r_multiple) || 0), 0);
  lines.push("", `RECENT RESULTS (last ${completed.length}): ${wins} wins, ${losses} losses, net ${netR.toFixed(2)}R`);
  for (const t of completed.slice(0, 8)) {
    lines.push(`- ${t.symbol} ${t.direction} ${t.timeframe}: ${t.result}, ${Number(t.r_multiple ?? 0).toFixed(2)}R`);
  }

  const dk = dayKey(now);
  lines.push("", `SIGNALS TODAY: ${Number(state.tracker?.daily?.[dk] ?? 0)} of ${DAILY_TARGET} (target is a minimum goal, quality is never forced)`);

  try {
    const cal = await getCalendar(env);
    const upcoming = upcomingNews(cal.events, now, 24, 6);
    lines.push("", "HIGH-IMPACT NEWS (next 24h):");
    if (!upcoming.length) lines.push(cal.source === "unavailable" ? "- calendar unavailable right now" : "- none");
    for (const n of upcoming) lines.push(`- ${n.time}: ${n.currency} ${n.title}`);
  } catch (_) { /* optional */ }

  return lines.join("\n").slice(0, 3500);
}

export async function runChat(env, userMessage) {
  const context = await buildChatContext(env);
  const system = `You are Sky AI, the assistant inside a Smart Money Concepts (SMC) forex and gold signals app.
Current time: ${new Date().toUTCString()}.

Use ONLY the app data below plus general trading knowledge. You have no live chart or price feed, so never invent prices, levels, news or results. If asked about a pair with no setup in the data, say there is no active setup and explain what the engine waits for: higher-timeframe alignment, a liquidity sweep, a BOS/CHoCH, a fresh order block, discount/premium location, and the London/New York sessions. B-GRADE setups are lower confidence and should use half risk.
Reply in plain text only (no markdown, no asterisks), under 150 words, easy to read on a phone. When you discuss a trade, end with one short line that this is not financial advice.

APP DATA
${context}`;

  const r = await callAI(env, {
    messages: [{ role: "system", content: system }, { role: "user", content: userMessage }],
    temperature: 0.3,
    maxTokens: 600
  });
  if (!r.ok) return { reply: "The AI service is unavailable right now. Please try again in a minute." };
  return { reply: String(r.message.content || "").trim() || "I couldn't generate a reply. Please try again." };
}

// Small in-memory limiter (per Worker instance) so a leaked URL can't drain your AI quota quickly.
const chatHits = [];
function allowChat() {
  const now = Date.now();
  while (chatHits.length && now - chatHits[0] > 60000) chatHits.shift();
  if (chatHits.length >= 20) return false;
  chatHits.push(now);
  return true;
}

export async function handleChat(request, env) {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type" }
    });
  }
  if (request.method !== "POST") return json({ error: "Use POST" }, headers, 405);

  let body;
  try { body = await request.json(); } catch (_) { return json({ error: "Invalid JSON" }, headers, 400); }
  const message = String(body?.message ?? "").trim().slice(0, 1000);
  if (!message) return json({ error: "Empty message" }, headers, 400);
  if (!allowChat()) return json({ reply: "Too many messages. Please wait a minute and try again." }, headers);

  try {
    return json(await runChat(env, message), headers);
  } catch (e) {
    console.error("Chat error:", e);
    return json({ reply: "Something went wrong. Please try again." }, headers);
  }
}

// ============================================
// 3. ORIGINAL AI NEWS AGENT (web search), kept with fixes
//    - tool results are now added correctly for multiple tool calls
//    - the follow-up call can use any provider (it used to be Gemini only)
// ============================================
async function webSearch(query) {
  try {
    const res = await fetchWithTimeout(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { "User-Agent": "Mozilla/5.0" }
    }, 8000);
    const html = await res.text();
    return html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2000) || "No news found.";
  } catch (_) {
    return "No news found.";
  }
}

export async function runAgent(env, userId, userMessage) {
  const tools = [
    { type: "function", function: {
      name: "web_search",
      description: "Search the web for current Forex news and economic calendars.",
      parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }
    }}
  ];

  const systemPrompt = `You are Sky, an elite Forex News and Sentiment Filter.
Current Time: ${new Date().toUTCString()}

Your ONLY job is to check if there is high-impact news (FOMC, NFP, CPI, Central Bank speeches) in the next 2 hours that would invalidate the requested trade.
Use the web_search tool to verify.
You MUST reply with ONLY a valid JSON object. Do not include markdown formatting like \`\`\`json.
Format: {"recommendation": "APPROVE" | "BLOCK", "reason": "Short explanation."}`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage }
  ];

  const first = await callAI(env, { messages, tools });
  if (!first.ok) return { reply: '{"recommendation": "BLOCK", "reason": "All AI providers failed."}' };

  const msg = first.message;
  const calls = msg.tool_calls || [];

  if (calls.length > 0) {
    messages.push(msg);
    for (const call of calls) {
      let content = "No news found.";
      if (call.function?.name === "web_search") {
        try {
          const args = JSON.parse(call.function.arguments || "{}");
          content = await webSearch(args.query || "forex high impact news today");
        } catch (_) { /* keep default */ }
      }
      messages.push({ role: "tool", tool_call_id: call.id, content });
    }
    const final = await callAI(env, { messages });
    if (final.ok && final.message.content) return { reply: final.message.content };
  }

  return { reply: msg.content || '{"recommendation": "BLOCK", "reason": "No response."}' };
}
