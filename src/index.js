import { handleApi } from "./api.js";
import { SYMBOLS } from "./market/symbols.js";
import {
  getSignal,
  scanAll,
  SignalTracker,
  fetchMarketCached,
  DEFAULT_CANDLE_LIMIT
} from "./engine.js";

// ============================================================
// CONFIG
// ============================================================
const SYMBOL_LIST = Object.keys(SYMBOLS);   // every pair in market/symbols.js

const CONFIG = {
  timeframes: ["M15", "H1"],      // higher-priority timeframe first
  candleMs: 15 * 60 * 1000,       // M15 candle length (used to read price candles)
  tfMs: { M5: 5 * 60e3, M15: 15 * 60e3, M30: 30 * 60e3, H1: 60 * 60e3, H4: 4 * 60 * 60e3 },
  maxCompleted: 50,
  watchExpiryCandles: 12,         // forming / unfilled setups die after this many candles of their timeframe
  cooldownMinutes: 60,            // no new signal on a symbol right after its trade closes
  maxMessagesPerRun: 12,          // protects Worker subrequest limits
  // Trade plan used for results AND Telegram text. R is tracked as if you follow it.
  partialSplits: { 1: [1], 2: [0.5, 0.5], 3: [0.5, 0.3, 0.2] },
  breakevenAfterTp1: true,        // stop moves to entry once TP1 is hit
  displayTimeZone: "Africa/Nairobi",
  cacheUrl: "https://sky-ai-backend.i96463073.workers.dev/api/prices-cache"
};

// Worker plans cap outside requests per run (free plan: 50). Rough use:
// 3 data calls per symbol (M15, H1, H4) + 2 KV + up to 12 Telegram messages.
if (SYMBOL_LIST.length * 3 + 2 + CONFIG.maxMessagesPerRun > 50) {
  console.warn(`${SYMBOL_LIST.length} symbols may exceed the 50-subrequest limit on the free plan.`);
}

// ============================================================
// SMALL HELPERS
// ============================================================
const toNum = (v) => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const clip = (s, n = 140) => {
  const t = String(s ?? "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function symbolMeta(symbol) {
  const s = String(symbol).toUpperCase();
  if (s.startsWith("XAU")) return { digits: 2, pip: 0.1 };
  if (s.endsWith("JPY")) return { digits: 3, pip: 0.01 };
  return { digits: 5, pip: 0.0001 };
}

const fmt = (symbol, v) => (toNum(v) === null ? "—" : Number(v).toFixed(symbolMeta(symbol).digits));
const pipsBetween = (symbol, a, b) => (Math.abs(a - b) / symbolMeta(symbol).pip).toFixed(1);

function confidencePct(raw) {
  const n = toNum(raw);
  if (n === null) return null;
  return Math.max(0, Math.min(100, Math.round(n <= 1 ? n * 100 : n)));
}

// Time shown to you in East Africa Time
function eatStamp(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: CONFIG.displayTimeZone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", hourCycle: "h23"
    }).formatToParts(d).map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute} EAT`;
}

function candleMs(c) {
  const v = c?.time ?? c?.t ?? c?.timestamp ?? c?.datetime ?? c?.date;
  if (typeof v === "number") return v < 1e12 ? v * 1000 : v;
  if (typeof v === "string") {
    const p = Date.parse(v);
    return Number.isNaN(p) ? null : p;
  }
  return null;
}

/**
 * High/low/close since `sinceMs`.
 * strictAfter = true only uses candles that OPENED after sinceMs (used for the breakeven check,
 * so lows from before TP1 was hit can't trigger a false breakeven exit).
 */
function extractRange(candles, sinceMs, strictAfter = false) {
  if (!Array.isArray(candles) || !candles.length) return null;
  const close = toNum(candles[candles.length - 1]?.close);
  if (close === null) return null;
  let high = close, low = close;
  for (const c of candles) {
    const t = candleMs(c);
    if (t === null) continue;
    if (strictAfter ? t < sinceMs : t + CONFIG.candleMs <= sinceMs) continue;
    const h = toNum(c.high), l = toNum(c.low);
    if (h !== null) high = Math.max(high, h);
    if (l !== null) low = Math.min(low, l);
  }
  return { close, high, low };
}

function rMultiple(trade, price) {
  const risk = Math.abs(trade.entry - trade.stop_loss);
  if (!risk) return 0;
  const move = trade.direction === "BUY" ? price - trade.entry : trade.entry - price;
  return move / risk;
}

const signedR = (r) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

const splitsFor = (n) => CONFIG.partialSplits[n] ?? Array(n).fill(1 / n);

/** Realized R for the plan: partial closes at each TP; the rest stops at breakeven (or the original stop). */
function realizedR(trade, tpHit, stoppedOut) {
  const sp = splitsFor(trade.take_profit.length);
  let r = 0, closed = 0;
  for (let i = 0; i < tpHit; i++) {
    r += sp[i] * rMultiple(trade, trade.take_profit[i]);
    closed += sp[i];
  }
  if (stoppedOut) {
    const stopR = tpHit >= 1 && CONFIG.breakevenAfterTp1 ? 0 : -1;
    r += (1 - closed) * stopR;
  }
  return r;
}

const expiryMs = (trade) =>
  CONFIG.watchExpiryCandles * (CONFIG.tfMs[trade.timeframe] ?? CONFIG.candleMs);

function planText(trade) {
  const sp = splitsFor(trade.take_profit.length);
  const parts = sp.map((p, i) => `${Math.round(p * 100)}% TP${i + 1}`);
  return parts.join(" · ") + (CONFIG.breakevenAfterTp1 ? " · SL to breakeven after TP1" : "");
}

// ============================================================
// STATE (KV)
// ============================================================
async function loadState(env) {
  const empty = { pending: [], completed: [], news: [], cooldowns: {}, tracker: {} };
  try {
    const raw = await env.SKY_MEMORY.get("app_state");
    if (!raw) return { raw: "", state: empty };
    const s = JSON.parse(raw);
    return {
      raw,
      state: {
        pending: Array.isArray(s.pending) ? s.pending : [],
        completed: Array.isArray(s.completed) ? s.completed : [],
        news: Array.isArray(s.news) ? s.news : [],
        cooldowns: s.cooldowns && typeof s.cooldowns === "object" ? s.cooldowns : {},
        tracker: s.tracker && typeof s.tracker === "object" ? s.tracker : {}
      }
    };
  } catch (e) {
    console.error("Corrupt app_state, starting fresh:", e);
    return { raw: "", state: empty };
  }
}

// ============================================================
// TELEGRAM
// ============================================================
async function sendTelegramMessage(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const text = message.length > 4000 ? message.slice(0, 3990) + "…" : message;

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          chat_id: env.TELEGRAM_CHAT_ID,
          text,
          parse_mode: "HTML",
          disable_web_page_preview: true
        })
      });
      if (res.ok) return true;
      const data = await res.json().catch(() => ({}));
      if (res.status === 429) {
        await sleep(Math.min((data?.parameters?.retry_after || 2) * 1000, 5000));
        continue;
      }
      console.error("Telegram rejected message:", res.status, data?.description);
      return false;
    } catch (e) {
      console.error("Failed to send Telegram message:", e);
    }
  }
  return false;
}

function renderBreakdown(b) {
  if (!b) return "";
  let items = [];
  if (Array.isArray(b)) {
    items = b.map((x) => clip(typeof x === "object" ? JSON.stringify(x) : x, 60));
  } else if (typeof b === "object") {
    items = Object.entries(b)
      .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
      .map(([k, v]) => {
        const val = typeof v === "number" ? (Number.isInteger(v) ? v : v.toFixed(1)) : v;
        return `${String(k).replace(/_/g, " ")}: ${val}`;
      });
  } else {
    items = [clip(b, 120)];
  }
  items = items.slice(0, 8);
  return items.length ? items.map((i) => `• ${esc(i)}`).join("\n") : "";
}

function statusLine(trade) {
  if (trade.watch) return "⏳ <b>Watchlist only</b> — conditions are not complete. Do NOT enter yet; you'll get an alert if it confirms.";
  switch (trade.entryStatus) {
    case "WAITING_FOR_RETEST":
      return "⏳ <b>Waiting for price to retest the Order Block.</b> Don't chase — let price come to the entry.";
    case "WAITING_FOR_CONFIRMATION":
      return "⏳ <b>Inside the Order Block.</b> Wait for a confirmation candle before entering.";
    default:
      return "✅ <b>Entry confirmed.</b> Trade is live and being tracked.";
  }
}

function buildSignalMessage(trade, kind) {
  const buy = trade.direction === "BUY";
  const s = trade.symbol;
  const risk = Math.abs(trade.entry - trade.stop_loss);

  const header =
    kind === "WATCH" ? "⏳ <b>SKY AI — SETUP FORMING</b> ⏳"
    : kind === "CONFIRMED" ? "✅ <b>SKY AI — SETUP CONFIRMED</b> ✅"
    : `🔥 <b>SKY AI — ${esc(trade.quality)} SIGNAL</b> 🔥`;

  const tpLines = trade.take_profit.map((tp, i) => {
    const r = risk ? Math.abs(tp - trade.entry) / risk : 0;
    return `🎯 <b>TP${i + 1}:</b> <code>${fmt(s, tp)}</code>  (+${pipsBetween(s, tp, trade.entry)} pips · 1:${r.toFixed(1)})`;
  });

  const finalR = risk ? Math.abs(trade.take_profit[trade.take_profit.length - 1] - trade.entry) / risk : 0;

  const lines = [
    header,
    "",
    `${buy ? "🟢" : "🔴"} <b>${trade.direction} ${esc(s)}</b> · ${esc(trade.timeframe)}` +
      (trade.session && trade.session !== "UNKNOWN" ? ` · ${esc(String(trade.session).replace(/_/g, " "))}` : ""),
    `🏅 Grade: <b>${esc(trade.quality)}</b>` + (trade.score !== null ? ` · Score ${trade.score}/100` : ""),
    trade.tier === "RELAXED" ? "⚠️ <b>Lower-confidence (B-grade).</b> Use half your normal risk." : null,
    "━━━━━━━━━━━━━━━━━━",
    `📍 <b>Entry:</b> <code>${fmt(s, trade.entry)}</code>`,
    `🛑 <b>Stop Loss:</b> <code>${fmt(s, trade.stop_loss)}</code>  (−${pipsBetween(s, trade.entry, trade.stop_loss)} pips)`,
    ...tpLines,
    `⚖️ <b>Max R:R:</b> 1:${finalR.toFixed(1)}`,
    `📋 <b>Plan:</b> ${esc(planText(trade))}`,
    "━━━━━━━━━━━━━━━━━━",
    statusLine(trade)
  ];

  if (trade.is_sd) lines.push("🏷 <b>Supply/Demand zone confirmed</b>");

  const why = [...(trade.confluence || []), ...(trade.reasons || [])]
    .map((x) => clip(x, 110))
    .filter(Boolean);
  const uniqueWhy = [...new Set(why)].slice(0, 6);
  if (uniqueWhy.length) lines.push("", "🧠 <b>Why this setup:</b>", ...uniqueWhy.map((w) => `• ${esc(w)}`));

  const bd = renderBreakdown(trade.breakdown);
  if (bd) lines.push("", "📊 <b>Score breakdown:</b>", bd);

  lines.push("", `🕒 ${eatStamp(trade.created_at)}`, "<i>Not financial advice. Manage your risk.</i>");
  return lines.filter((l) => l !== null).filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n").trim();
}

function buildEntryMessage(trade) {
  return [
    `📥 <b>ENTRY TRIGGERED</b> — ${trade.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"} <b>${esc(trade.symbol)}</b> (${esc(trade.timeframe)})`,
    `Price reached the entry zone at <code>${fmt(trade.symbol, trade.entry)}</code>.`,
    `🛑 SL: <code>${fmt(trade.symbol, trade.stop_loss)}</code> · 🎯 TP1: <code>${fmt(trade.symbol, trade.take_profit[0])}</code>`
  ].join("\n");
}

function buildTpHitMessage(trade, tpIndex) {
  const tp = trade.take_profit[tpIndex - 1];
  const remaining = trade.take_profit.length - tpIndex;
  const be = CONFIG.breakevenAfterTp1 && tpIndex === 1
    ? `Move your stop to breakeven (<code>${fmt(trade.symbol, trade.entry)}</code>). Results are tracked as if you did.`
    : "";
  return [
    `🎯 <b>TP${tpIndex} HIT</b> — ${trade.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"} <b>${esc(trade.symbol)}</b> (${esc(trade.timeframe)})`,
    `Price reached <code>${fmt(trade.symbol, tp)}</code> (+${pipsBetween(trade.symbol, tp, trade.entry)} pips · ${signedR(rMultiple(trade, tp))}).`,
    remaining > 0 ? `Still running toward TP${tpIndex + 1}.` : "",
    be
  ].filter(Boolean).join("\n");
}

function buildClosedMessage(trade, completed) {
  const win = trade.result === "WIN";
  const wins = completed.filter((t) => t.result === "WIN").length;
  const rate = completed.length ? Math.round((wins / completed.length) * 100) : 0;
  const netR = completed.reduce((sum, t) => sum + (toNum(t.r_multiple) ?? 0), 0);
  const r = trade.r_multiple;
  const icon = trade.result === "WIN" ? "✅" : trade.result === "LOSS" ? "❌" : "➖";
  return [
    `${icon} <b>TRADE CLOSED — ${trade.result}</b>`,
    `${trade.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"} <b>${esc(trade.symbol)}</b> (${esc(trade.timeframe)})`,
    "━━━━━━━━━━━━━━━━━━",
    `Entry: <code>${fmt(trade.symbol, trade.entry)}</code>`,
    `Exit: <code>${fmt(trade.symbol, trade.exit_price)}</code>`,
    `Realized: <b>${signedR(r)}</b> (after partials${CONFIG.breakevenAfterTp1 ? " & breakeven" : ""})`,
    `TPs hit: ${trade.tp_hit}/${trade.take_profit.length}`,
    "━━━━━━━━━━━━━━━━━━",
    `📊 Last ${completed.length} trades: ${wins}W / ${completed.length - wins}L (${rate}% win rate) · Net ${signedR(netR)}`
  ].join("\n");
}

function buildCancelMessage(trade, reason) {
  const text =
    reason === "INVALIDATED" ? "Price hit the stop level before the entry was valid — setup is void."
    : "The setup didn't trigger in time and has been removed.";
  return [
    `${reason === "INVALIDATED" ? "🚫 <b>SETUP INVALIDATED</b>" : "⌛ <b>SETUP EXPIRED</b>"} — ${trade.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"} <b>${esc(trade.symbol)}</b> (${esc(trade.timeframe)})`,
    text
  ].join("\n");
}

// ============================================================
// SIGNAL → TRADE (validated)
// ============================================================
function buildTrade(res, symbol, tf) {
  const sig = res.signal;
  const lv = sig.levels || {};
  const rawDir = sig.decision === "NO_TRADE" ? sig.direction : sig.decision;
  const direction = String(rawDir ?? "").toUpperCase();
  if (direction !== "BUY" && direction !== "SELL") return null;

  const entry = toNum(lv.entry);
  const sl = toNum(lv.stop_loss);
  const buy = direction === "BUY";
  let tps = (Array.isArray(lv.take_profit) ? lv.take_profit : []).map(toNum).filter((v) => v !== null);
  if (entry === null || sl === null) return null;
  if (buy ? sl >= entry : sl <= entry) return null;
  tps = tps.filter((tp) => (buy ? tp > entry : tp < entry)).sort((a, b) => (buy ? a - b : b - a));
  if (!tps.length) return null;

  const isWatch = res.status === "SETUP_FORMING";
  const entryStatus = sig.entryStatus || "CONFIRMED_ENTRY";
  const now = new Date().toISOString();

  return {
    id: "sig_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
    symbol,
    direction,
    entry,
    stop_loss: sl,
    take_profit: tps,
    confidence: sig.confidence ?? sig.score,
    confidence_pct: confidencePct(sig.confidence ?? sig.score),
    score: toNum(sig.score),
    tier: sig.tier || res.tier || null,
    quality: sig.quality || "WATCHLIST",
    breakdown: sig.breakdown,
    is_sd: !!sig.is_sd,
    confluence: Array.isArray(sig.confluence) ? sig.confluence : [],
    reasons: Array.isArray(sig.reasons) ? sig.reasons : [],
    created_at: now,
    updated_at: now,
    last_checked: now,
    timeframe: tf,
    tp_hit: 0,
    watch: isWatch,
    entered: !isWatch && entryStatus === "CONFIRMED_ENTRY",
    entryStatus,
    session: sig.session || "UNKNOWN"
  };
}

const rank = (t) => (t.watch ? 0 : 1000) + (toNum(t.score) || 0);

const jsonResponse = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });

// Optional: set an ADMIN_KEY secret to protect the /test-* routes (call them with ?key=...).
const authorized = (url, env) => !env.ADMIN_KEY || url.searchParams.get("key") === env.ADMIN_KEY;

// ============================================================
// WORKER
// ============================================================
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);

    if (url.pathname === "/test-signal") {
      if (!authorized(url, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      const symbol = url.searchParams.get("symbol") || "XAUUSD";
      const timeframe = url.searchParams.get("timeframe") || "M15";
      try {
        return jsonResponse(await getSignal(env, symbol, timeframe));
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e) }, 500);
      }
    }

    // Dry run of the all-pairs scan (does not save state or send alerts)
    if (url.pathname === "/test-scan") {
      if (!authorized(url, env)) return jsonResponse({ ok: false, error: "Unauthorized" }, 401);
      try {
        return jsonResponse(await scanAll(env, { timeframes: CONFIG.timeframes, tracker: new SignalTracker() }));
      } catch (e) {
        return jsonResponse({ ok: false, error: String(e) }, 500);
      }
    }

    return new Response("Sky AI Backend is running.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    console.log(`Cron Job Started: scanning ${SYMBOL_LIST.length} pairs...`);
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();

    const { raw: oldRaw, state } = await loadState(env);
    let completed = state.completed;
    const news = state.news;
    const cooldowns = state.cooldowns;
    const tracker = new SignalTracker(state.tracker);   // daily count, cooldowns, watch expiry
    const marketCache = new Map();                      // one data call per symbol/timeframe this run
    const notifications = [];

    // ---------- 1. FETCH LIVE PRICES + RECENT CANDLES ----------
    const livePrices = {};
    const candlesBySymbol = {};
    await Promise.all(
      SYMBOL_LIST.map(async (symbol) => {
        try {
          const md = await fetchMarketCached(env, symbol, "M15", DEFAULT_CANDLE_LIMIT, marketCache);
          if (md?.ok && Array.isArray(md.candles) && md.candles.length) {
            const close = toNum(md.candles[md.candles.length - 1].close);
            if (close !== null) {
              livePrices[symbol] = close;
              candlesBySymbol[symbol] = md.candles;
            }
          }
        } catch (e) {
          console.error(`Error fetching price for ${symbol}:`, e);
        }
      })
    );

    // ---------- 2. MANAGE EXISTING TRADES / WATCHLIST ----------
    let active = [];
    for (const trade of state.pending) {
      try {
        // Malformed trade → drop it quietly rather than crash the run
        if (!trade.symbol || !Array.isArray(trade.take_profit) || !trade.take_profit.length ||
            toNum(trade.entry) === null || toNum(trade.stop_loss) === null) {
          console.error("Dropping malformed trade:", trade?.id);
          continue;
        }

        const candles = candlesBySymbol[trade.symbol];
        const sinceMs = Date.parse(trade.last_checked || trade.created_at) || 0;
        const rng = candles ? extractRange(candles, sinceMs) : null;
        if (!rng) { active.push(trade); continue; }

        const buy = trade.direction === "BUY";
        const ageMs = nowMs - (Date.parse(trade.created_at) || nowMs);
        const slHit = buy ? rng.low <= trade.stop_loss : rng.high >= trade.stop_loss;

        // --- Watchlist (not entered, not tradable yet) ---
        if (trade.watch) {
          if (slHit) { notifications.push(buildCancelMessage(trade, "INVALIDATED")); continue; }
          if (ageMs > expiryMs(trade)) { notifications.push(buildCancelMessage(trade, "EXPIRED")); continue; }
          trade.last_checked = nowIso;
          active.push(trade);
          continue;
        }

        // --- Confirmed setup waiting for entry fill ---
        if (!trade.entered) {
          const touched = buy ? rng.low <= trade.entry : rng.high >= trade.entry;
          if (!touched) {
            if (ageMs > expiryMs(trade)) { notifications.push(buildCancelMessage(trade, "EXPIRED")); continue; }
            trade.last_checked = nowIso;
            active.push(trade);
            continue;
          }
          trade.entered = true;
          if (!slHit) notifications.push(buildEntryMessage(trade));
        }

        // --- Live trade: TP / stop (conservative: stop wins if touched in the same window as a new TP) ---
        const tps = trade.take_profit;
        const priorTp = trade.tp_hit || 0;
        let newTp = 0;
        tps.forEach((tp, i) => {
          if (buy ? rng.high >= tp : rng.low <= tp) newTp = i + 1;
        });

        // After TP1 the stop sits at breakeven; only look at candles opened after TP1 was recorded.
        const beActive = CONFIG.breakevenAfterTp1 && priorTp >= 1;
        let stopHit = slHit;
        if (beActive) {
          const beRng = extractRange(candles, Date.parse(trade.be_since) || sinceMs, true);
          stopHit = beRng ? (buy ? beRng.low <= trade.entry : beRng.high >= trade.entry) : false;
        }

        let result = null, exitPrice = null, rReal = 0;
        if (stopHit) {
          // credit only TPs recorded in earlier runs
          rReal = realizedR(trade, priorTp, true);
          exitPrice = beActive ? trade.entry : trade.stop_loss;
          trade.tp_hit = priorTp;
          result = rReal >= 0.01 ? "WIN" : rReal <= -0.01 ? "LOSS" : "BREAKEVEN";
        } else {
          trade.tp_hit = Math.max(priorTp, newTp);
          if (trade.tp_hit >= tps.length) {
            rReal = realizedR(trade, tps.length, false);
            exitPrice = tps[tps.length - 1];
            result = "WIN";
          }
        }

        if (result) {
          trade.result = result;
          trade.exit_price = exitPrice;
          trade.closed_at = nowIso;
          trade.r_multiple = Number(rReal.toFixed(2));
          completed.unshift(trade);
          completed = completed.slice(0, CONFIG.maxCompleted);
          cooldowns[trade.symbol] = new Date(nowMs + CONFIG.cooldownMinutes * 60000).toISOString();
          notifications.push(buildClosedMessage(trade, completed));
        } else {
          if (priorTp === 0 && trade.tp_hit >= 1) trade.be_since = nowIso;
          for (let i = priorTp + 1; i <= trade.tp_hit; i++) notifications.push(buildTpHitMessage(trade, i));
          trade.last_checked = nowIso;
          active.push(trade);
        }
      } catch (e) {
        console.error("Error managing trade:", trade?.id, e);
        active.push(trade);
      }
    }

    // Prune expired cooldowns
    for (const [sym, until] of Object.entries(cooldowns)) {
      if (!(Date.parse(until) > nowMs)) delete cooldowns[sym];
    }

    // ---------- 3. SCAN ALL PAIRS FOR NEW SIGNALS / UPGRADE WATCHLIST ----------
    const lockedTrades = active.filter((t) => !t.watch);
    const lockedSymbols = new Set(lockedTrades.map((t) => t.symbol.toUpperCase()));
    const eligible = SYMBOL_LIST.filter(
      (s) => !lockedSymbols.has(s) && !(cooldowns[s] && Date.parse(cooldowns[s]) > nowMs)
    );

    let scan = null;
    if (eligible.length) {
      try {
        scan = await scanAll(env, {
          symbols: eligible,
          timeframes: CONFIG.timeframes,
          tracker,
          activeSymbols: [...lockedSymbols],
          openTrades: lockedTrades.map((t) => ({ symbol: t.symbol, direction: t.direction })),
          marketCache,
          timestamp: nowMs
        });
        if (scan.skipped) console.log("Scan skipped:", scan.skipped);
        else console.log(`Scan done: ${scan.signals.length} signal(s), ${scan.candidates.length} candidate(s), quota ${scan.quota.count}/${scan.quota.target}`);
      } catch (e) {
        console.error("scanAll failed:", e);
      }
    }

    for (const res of scan?.candidates ?? []) {
      const symbol = res.symbol;
      if (!symbol || lockedSymbols.has(symbol)) continue;
      const best = buildTrade(res, symbol, res.timeframe);
      if (!best) continue;

      const existingIdx = active.findIndex((t) => t.watch && t.symbol.toUpperCase() === symbol);
      const existing = existingIdx >= 0 ? active[existingIdx] : null;

      if (existing) {
        if (best.watch && best.direction === existing.direction) {
          // Same forming setup → silently refresh levels, no spam
          Object.assign(existing, {
            entry: best.entry, stop_loss: best.stop_loss, take_profit: best.take_profit,
            confidence: best.confidence, confidence_pct: best.confidence_pct, score: best.score,
            timeframe: best.timeframe, entryStatus: best.entryStatus,
            confluence: best.confluence, reasons: best.reasons, breakdown: best.breakdown,
            updated_at: nowIso
          });
          continue;
        }
        active.splice(existingIdx, 1); // replaced (upgraded to confirmed, or direction flipped)
      }

      active.push(best);
      if (!best.watch) lockedSymbols.add(symbol);
      console.log(`🚀 NEW SIGNAL: ${symbol} ${best.timeframe} | ${best.direction} | ${best.entryStatus}${best.watch ? " (watch)" : ""}`);

      const kind = best.watch ? "WATCH" : existing && existing.direction === best.direction ? "CONFIRMED" : "NEW";
      notifications.push(buildSignalMessage(best, kind));
    }

    // ---------- 4. SAVE STATE FIRST (prevents duplicate alerts if Telegram fails) ----------
    const cache = caches.default;
    const cacheKey = new Request(CONFIG.cacheUrl, { method: "GET" });
    const cacheResponse = new Response(JSON.stringify(livePrices), {
      headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=300" }
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResponse));

    const newRaw = JSON.stringify({ pending: active, completed, news, cooldowns, tracker: tracker.snapshot(nowMs) });
    if (newRaw !== oldRaw) {
      try {
        await env.SKY_MEMORY.put("app_state", newRaw);
      } catch (e) {
        console.error("Failed to save app_state:", e);
        return; // don't send alerts for state we couldn't persist
      }
    }

    // ---------- 5. SEND TELEGRAM ALERTS ----------
    for (const msg of notifications.slice(0, CONFIG.maxMessagesPerRun)) {
      await sendTelegramMessage(env, msg);
      await sleep(350); // stay under Telegram's per-chat rate limit
    }
    if (notifications.length > CONFIG.maxMessagesPerRun) {
      console.error(`Skipped ${notifications.length - CONFIG.maxMessagesPerRun} alerts (per-run cap).`);
    }
  }
};
