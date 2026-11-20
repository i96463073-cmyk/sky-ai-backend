// ============================================================
// SKY AI — BRAIN
// A rule-based assistant that runs entirely inside your Worker.
// No Gemini, Groq or any other AI service: it reads your live data
// (signals, results, last scan, economic calendar) and answers in plain text.
// It only states what the data says; it never invents prices or results.
// ============================================================
import { SYMBOLS } from "./market/symbols.js";
import { getSignal } from "./engine.js";
import { getCalendar, newsCheck, upcomingNews, symbolCurrencies, runChat, askAI, buildChatContext } from "./agent.js";
import { fetchBrief, ruleReport, reasoningMessages, plainReason } from "./analyst.js";
import {
  loadMemory, saveMemory, insights, pairBias, addNote, addQa, removeKnowledge, searchKnowledge,
  pausePair, resumePair, runResearch, headlinesFor, toneFor
} from "./memory.js";

const TZ = "Africa/Nairobi";
const DAILY_TARGET = 3;
const NEWS_BEFORE_MIN = 30;     // keep in sync with CONFIG in index.js
const NEWS_AFTER_MIN = 30;
const SCAN_STALE_MIN = 45;      // older than this -> do a live check instead of trusting the stored scan

// ---------- time helpers (formatters are cached: free-plan CPU is tiny) ----------
const fmtCache = new Map();
function dtf(key, opts) {
  if (!fmtCache.has(key)) fmtCache.set(key, new Intl.DateTimeFormat("en-GB", opts));
  return fmtCache.get(key);
}
const hourIn = (ms, tz) =>
  Number(dtf("h:" + tz, { timeZone: tz, hour: "numeric", hourCycle: "h23" }).format(new Date(ms))) % 24;

function eat(ms) {
  return dtf("eat", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(ms)) + " EAT";
}
function eatDay(ms) {
  return dtf("eatday", { timeZone: TZ, weekday: "short", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(ms)).replace(",", "") + " EAT";
}
function dayKey(ms) {
  const p = Object.fromEntries(dtf("day", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

// same windows as the engine: London open 08-11 London time, New York open 08-11 New York time
function sessionAt(ms) {
  const wd = new Date(ms).getUTCDay();
  if (wd === 0 || wd === 6) return "WEEKEND";
  const l = hourIn(ms, "Europe/London"), n = hourIn(ms, "America/New_York");
  if (l >= 8 && l < 11) return "LONDON_OPEN";
  if (n >= 8 && n < 11) return "NY_OPEN";
  if (l >= 11 && l < 16) return "LONDON_MID";
  if (n >= 11 && n < 14) return "NY_MID";
  if (l < 8) return "ASIAN";
  return "OFF_HOURS";
}
const SESSION_TEXT = {
  LONDON_OPEN: "London open", NY_OPEN: "New York open", LONDON_MID: "London mid-session",
  NY_MID: "New York mid-session", ASIAN: "Asian session", OFF_HOURS: "off-hours", WEEKEND: "weekend (market closed)"
};
function nextOpenWindow(nowMs) {
  const start = Math.ceil(nowMs / 3600000) * 3600000;
  for (let k = 0; k < 96; k++) {
    const t = start + k * 3600000;
    const s = sessionAt(t);
    if (s === "LONDON_OPEN" || s === "NY_OPEN") return { t, s };
  }
  return null;
}
const ago = (ms) => {
  const m = Math.max(0, Math.round((Date.now() - ms) / 60000));
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`;
};

// ---------- symbols ----------
const ALIASES = {
  GOLD: "XAUUSD", XAU: "XAUUSD", EURO: "EURUSD", EUR: "EURUSD", CABLE: "GBPUSD", POUND: "GBPUSD", GBP: "GBPUSD",
  YEN: "USDJPY", JPY: "USDJPY", AUSSIE: "AUDUSD", AUD: "AUDUSD", LOONIE: "USDCAD", CAD: "USDCAD",
  SWISSY: "USDCHF", CHF: "USDCHF", KIWI: "NZDUSD", NZD: "NZDUSD"
};
function findSymbols(text) {
  const found = [];
  const add = (s, pos) => { if (SYMBOLS[s] && !found.some((f) => f.s === s)) found.push({ s, pos }); };
  const merged = text.toUpperCase().replace(/[\/\s_-]/g, "");
  for (const s of Object.keys(SYMBOLS)) { const p = merged.indexOf(s); if (p >= 0) add(s, p); }
  const up = text.toUpperCase();
  for (const [word, s] of Object.entries(ALIASES)) {
    const m = up.match(new RegExp(`\\b${word}\\b`));
    if (m) add(s, m.index + 10000);
  }
  return found.sort((a, b) => a.pos - b.pos).map((f) => f.s);
}
function findTf(text) {
  const t = text.toLowerCase();
  const direct = t.match(/\b(m5|m15|m30|h1|h4)\b/);
  if (direct) return direct[1].toUpperCase();
  let m = t.match(/(\d+)\s*(?:m|min|mins|minute|minutes)\b/);
  if (m) { const v = Number(m[1]); if (v === 5) return "M5"; if (v === 15) return "M15"; if (v === 30) return "M30"; }
  m = t.match(/(\d+)\s*(?:h|hr|hrs|hour|hours)\b/);
  if (m) { const v = Number(m[1]); if (v === 1) return "H1"; if (v === 4) return "H4"; }
  if (/\bhourly\b/.test(t)) return "H1";
  return null;
}
const digits = (s) => (String(s).startsWith("XAU") ? 2 : String(s).endsWith("JPY") ? 3 : 5);
const pipSize = (s) => (String(s).includes("JPY") ? 0.01 : String(s).includes("XAU") ? 0.1 : 0.0001);
const fx = (s, v) => (Number.isFinite(Number(v)) ? Number(v).toFixed(digits(s)) : "—");
const pips = (s, a, b) => (Math.abs(a - b) / pipSize(s)).toFixed(1);
const signedR = (r) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R`;

// ---------- data ----------
async function readState(env) {
  try { return JSON.parse((await env.SKY_MEMORY.get("app_state")) || "{}") || {}; } catch (_) { return {}; }
}
async function getCtx(env, preloaded) {
  const now = Date.now();
  const state = await readState(env);
  const mem = preloaded || await loadMemory(env);
  let cal = { events: [], source: "unavailable" };
  try { cal = await getCalendar(env); } catch (_) { /* optional */ }
  const pending = Array.isArray(state.pending) ? state.pending : [];
  const completed = Array.isArray(state.completed) ? state.completed : [];
  const blocked = {};
  for (const s of Object.keys(SYMBOLS)) {
    const n = newsCheck(cal.events, s, now, { beforeMin: NEWS_BEFORE_MIN, afterMin: NEWS_AFTER_MIN });
    if (n.block) blocked[s] = n.reason;
  }
  return {
    now, state, cal, pending, completed, blocked, mem,
    lastScan: state.lastScan || null,
    daily: Number(state.tracker?.daily?.[dayKey(now)] ?? 0)
  };
}

const phaseOf = (t) => (t.watch ? "watching" : t.entered ? "ACTIVE" : "waiting for entry");

// ---------- plain-language reasons (shared with the analyst and the pictures) ----------
const plain = plainReason;

// ---------- intents ----------
function detect(msg) {
  const t = msg.toLowerCase();
  const syms = findSymbols(msg);
  const has = (re) => re.test(t);

  if (has(/^\s*(hi|hello|hey|yo|good (morning|afternoon|evening))\b/) && t.split(/\s+/).length <= 4) return "greet";
  if (/^\s*ai\s*[:\-]\s*\S/i.test(msg)) return "ai";
  const first = t.trim().match(/^(remember|note|learn|forget|pause|resume|unpause)\b/);
  if (first) return first[1] === "unpause" ? "resume" : first[1];
  if (has(/\b(lot size|position size|lots?)\b/) && has(/\d/)) return "calc";
  if (has(/\b(photo|picture|image|drawing|draw|annotated|marked|visual|screenshot)\b/) || has(/\b(show|send|give|open)\b.{0,15}\bchart\b|\bchart (of|for)\b/)) return "image";
  if (has(/\bexplain\b.{0,20}\bsignal\b|\bsignal and its risks\b|\bits risks\b/)) return "explain";
  if (has(/\b(thanks|thank you|thx)\b/)) return "thanks";
  if (has(/\bwho are you\b|\bwhat are you\b|\byour name\b|\bwho (made|built|created) you\b/)) return "intro";
  if (has(/\b(what is|what's|what are|explain|define|meaning of|mean)\b/) && glossaryMatch(t)) return "glossary";
  if (has(/\b(export|backup)\b.*\bbrain\b|\bbrain\b.*\b(export|backup)\b/)) return "export";
  if (has(/\bpaused\b|\bwhich pairs are (off|paused)\b/)) return "paused";
  if (has(/\b(my notes|notes|what do you remember|what have i taught|what did i teach)\b/)) return "notes";
  if (has(/\b(lessons?|what have you learned|what did you learn|insights?|mistakes|weakness(es)?|how can you improve|suggestions?|learned so far)\b/)) return "lessons";
  if (has(/\b(research now|refresh news|update news|fetch news|research the news|do research)\b/)) return "research";
  if (has(/\b(headlines?|sentiment|what'?s happening|what is happening|latest news|market news|news (on|about|for))\b/)) return "headlines";
  if (has(/\bwhat do you know\b|\bdo you remember\b|\bwhat did i tell you\b/)) return "know";
  if (has(/\b(performance|win rate|results?|statistics|stats|how am i doing|net r|profit|losing|losses)\b/) && !has(/\bexplain this signal\b/)) return "perf";
  if (has(/\b(news|calendar|nfp|cpi|fomc|high.impact|red folder|economic)\b/)) return "news";
  if (has(/\b(should i trade|can i trade|safe to trade|good time to trade|trade now|trade today)\b/)) return "should";
  if (has(/\b(session|killzone|market open|market closed|london|new york|asian|when does|next window|next session|prime window|when is the next)\b/) && !syms.length) return "session";
  if (has(/\bhow many\b|\btoday\b|\bquota\b|\bdaily\b/) && has(/signal/)) return "status";
  if (has(/\bscan\b|all (markets|pairs)|every pair|rank them/) || syms.length >= 3) return "scan";
  if (has(/high.quality|best setup|top setup|strongest|best trade/)) return "best";
  if (syms.length && has(/\b(should i|can i|worth|good (buy|sell|trade)|what do you think|your (view|opinion)|outlook|bias|forecast|going (up|down)|next move|buy or sell|long or short|compare|versus|vs)\b/)) return "analyse";
  if (has(/\b(analy[sz]e|analysis|structure|chart|why|check|what about|how is|how's|look at)\b/) && syms.length) return "analyse";
  if (has(/\b(no signals?|why no|why aren't|why isn't|nothing)\b/)) return "scan";
  if (has(/\b(signals?|setups?|trades?|active|open|waiting|watch(list)?|positions?)\b/)) return "signals";
  if (has(/\b(status|overview|summary|today|how many|quota|daily|update)\b/)) return "status";
  if (has(/\b(help|what can you do|commands|menu|options)\b/)) return "help";
  if (syms.length) return "analyse";
  if (glossaryMatch(t)) return "glossary";
  return "unknown";
}

// ---------- glossary ----------
const GLOSSARY = [
  [/order ?blocks?|\bobs?\b/, "Order block",
    "The last opposite candle before a strong move that breaks structure. Price often comes back to it (a retest). Sky only uses a block that is fresh: never touched, or tapped for the first time right now."],
  [/liquidity sweep|\bsweeps?\b|stop hunt/, "Liquidity sweep",
    "Price wicks past an obvious high or low (where stop orders sit) and then closes back inside. It often comes just before a real move the other way. Sky wants a sweep before the move that created the order block."],
  [/liquidity|equal (highs|lows)/, "Liquidity",
    "Orders resting above highs and below lows. Equal highs or lows are especially attractive targets, so Sky caps take-profits just before them."],
  [/\bbos\b|break of structure/, "Break of structure (BOS)",
    "A candle closes beyond the last swing high or low in the direction of the current trend. It shows the trend is continuing."],
  [/choch|change of character/, "Change of character (CHOCH)",
    "A candle closes beyond a swing against the current trend, an early sign the trend may be turning."],
  [/\bfvg\b|fair value gap|imbalance/, "Fair value gap (FVG)",
    "A gap left by three candles where price moved too fast. Price often returns to fill it. In Sky it adds 5 points to the score when it formed in the same move as the order block."],
  [/premium|discount|equilibrium/, "Premium and discount",
    "The range between the last swing high and low is split at 50%. Below the middle is discount (buys only) and above is premium (sells only), so you buy cheap and sell expensive."],
  [/displacement/, "Displacement",
    "A very strong candle (large body, small wicks) that shows real buying or selling pressure. Sky needs one to create an order block."],
  [/killzone|sessions?|london open|new york open/, "Sessions",
    "Strict signals are only taken at the London open (08:00–11:00 London time) and New York open (08:00–11:00 New York time), when volume and clean moves are most likely."],
  [/risk.?reward|\br:r\b|\br multiple\b|\br\b/, "R and risk:reward",
    "1R is the amount you risk, from entry to stop. A 2R target pays twice your risk. Sky targets 2R, 3R and 4R and tracks results in R."],
  [/break.?even/, "Breakeven",
    "After TP1 is hit, the stop moves to your entry so the rest of the trade can no longer lose."],
  [/supply|demand/, "Supply and demand",
    "Areas where price turned sharply before. Sky gives a 5-point bonus when price sits near an untouched swing low (buys) or high (sells)."],
  [/\bhtf\b|higher.?timeframe/, "Higher timeframe (HTF)",
    "M15 signals must agree with the H1 trend, and H1 signals with H4. Trading with the bigger trend improves the odds."],
  [/b.?grade|high quality|\bgrades?\b/, "Grades",
    "HIGH (score 100) and GOOD (95) are full-confidence signals. B-GRADE is a lower-confidence setup used only to work toward your daily target. Use half your normal risk on it."],
  [/watch ?list|waiting for entry|active trade|phases?/, "Setup phases",
    "Watchlist: still forming, do not enter. Waiting for entry: confirmed, price has not reached the entry yet. Active: price reached your entry and the trade is running."],
  [/\batr\b/, "ATR",
    "Average True Range: the typical size of a candle. Sky measures stops and zones in ATR so they adapt to each pair."],
  [/cooldown|exposure/, "Cooldown and exposure",
    "After a trade closes, that pair rests for 60 minutes. Sky also blocks a third same-side trade on one currency so one news event cannot hit several trades at once."],
  [/tp1|tp2|tp3|take.?profit|partial/, "Targets",
    "The plan closes 50% at TP1, 30% at TP2 and 20% at TP3, with the stop moved to breakeven after TP1."]
];
function glossaryMatch(t) { return GLOSSARY.find(([re]) => re.test(t)) || null; }

// ---------- answers ----------
function aHelp() {
  return [
    "I'm Sky's built-in brain. I run on your own data and work even with no outside AI. Ask me things like:",
    "• status / should I trade now?",
    "• analyse EURUSD (or gold, GBPUSD M15…)",
    "• scan all markets / why no signals?",
    "• any setups? / best setup",
    "• explain the latest signal",
    "• performance / win rate",
    "• news today",
    "• session / when is the next window?",
    "• what is an order block? (also sweep, BOS, FVG, premium…)",
    "• lot size EURUSD entry 1.1000 stop 1.0980 balance 1000 risk 1%",
    "• show EURUSD chart / draw the latest trade (a marked picture that explains it)",
    "• ai: <any question>  (uses a free AI service if you connect one)",
    "",
    "I also learn and remember:",
    "• what have you learned? (lessons from your results)",
    "• headlines USD / news sentiment / research now",
    "• remember: <note>   ·   learn: question => answer   ·   notes   ·   forget <id>",
    "• pause GBPUSD / resume GBPUSD / paused"
  ].join("\n");
}

function aStatus(c) {
  const s = sessionAt(c.now);
  const act = c.pending.filter((t) => !t.watch && t.entered).length;
  const wait = c.pending.filter((t) => !t.watch && !t.entered).length;
  const watch = c.pending.filter((t) => t.watch).length;
  const lines = [`Sky status · ${eat(c.now)}`];
  lines.push(`• Session: ${SESSION_TEXT[s]}`);
  lines.push(`• Signals today: ${c.daily} of ${DAILY_TARGET} (a minimum goal, never forced)`);
  lines.push(`• Trades: ${act} active · ${wait} waiting · ${watch} watching`);
  const bl = Object.entries(c.blocked);
  lines.push(bl.length ? `• News pause: ${bl.map(([k, v]) => `${k} (${v})`).join("; ")}` : "• News pause: none");
  const ps = Object.keys(c.mem.pauses || {});
  if (ps.length) lines.push(`• Paused by you: ${ps.join(", ")}`);
  if (c.lastScan?.at) lines.push(`• Last scan: ${ago(Date.parse(c.lastScan.at))}`);
  else lines.push("• Last scan: not recorded yet");
  return lines.join("\n");
}

function aShould(c) {
  const s = sessionAt(c.now);
  const open = s === "LONDON_OPEN" || s === "NY_OPEN";
  const lines = [`Right now · ${eat(c.now)}`];
  lines.push(`• Session: ${SESSION_TEXT[s]} ${open ? "✅ best time" : "⚠️ quiet"}`);
  const bl = Object.entries(c.blocked);
  lines.push(bl.length ? `• News: avoid ${bl.map(([k]) => k).join(", ")} (${bl[0][1]})` : "• News: clear for all pairs");
  lines.push(`• Signals today: ${c.daily} of ${DAILY_TARGET}`);
  const tradable = c.pending.filter((t) => !t.watch);
  if (tradable.length) lines.push(`• Setups: ${tradable.map((t) => `${t.symbol} ${t.direction} (${phaseOf(t)})`).join(", ")}`);
  else lines.push("• Setups: none confirmed right now");
  let verdict;
  if (s === "WEEKEND") verdict = "The market is closed. Nothing to trade until Monday.";
  else if (!open) {
    const nx = nextOpenWindow(c.now);
    verdict = `Quiet window, so strict signals are paused. ${nx ? `Next prime window: ${eatDay(nx.t)}.` : ""}`;
  } else if (tradable.length) verdict = "Only trade the setups Sky lists, at the entry shown, with the stop in place.";
  else verdict = "Good window, but no setup qualifies yet. Waiting is a valid decision.";
  lines.push("", verdict, "Not financial advice.");
  return lines.join("\n");
}

function tradeBlock(t) {
  const sy = t.symbol, tps = (t.take_profit || []).map((x) => fx(sy, x)).join(" / ");
  const risk = Math.abs(Number(t.entry) - Number(t.stop_loss));
  const rr = risk ? (Math.abs(Number(t.take_profit?.[0]) - Number(t.entry)) / risk).toFixed(1) : "—";
  return `• ${sy} ${t.direction} ${t.timeframe} · ${phaseOf(t)}${t.tp_hit ? ` · TP${t.tp_hit} hit` : ""} · ${t.quality || "?"}\n` +
    `  entry ${fx(sy, t.entry)} · SL ${fx(sy, t.stop_loss)} (${pips(sy, t.entry, t.stop_loss)} pips) · TP ${tps} · 1:${rr}`;
}

function aSignals(c, onlyBest) {
  let list = c.pending;
  if (onlyBest) list = list.filter((t) => !t.watch && (t.quality === "HIGH" || t.quality === "GOOD"));
  if (!list.length) {
    const b = c.pending.filter((t) => !t.watch && t.quality === "B-GRADE").length;
    const w = c.pending.filter((t) => t.watch).length;
    return (onlyBest ? "No high-quality setups right now." : "No setups right now.") +
      (b ? ` (${b} lower-confidence B-grade setup(s) exist.)` : "") + (w ? ` ${w} on the watchlist, still forming.` : "") +
      "\nThe engine only publishes a signal when the rules line up. Waiting is a valid decision.";
  }
  const order = { ACTIVE: 0, "waiting for entry": 1, watching: 2 };
  let biased = false;
  const rankScore = (t) => {
    const b = pairBias(c.mem, t.symbol);
    if (!b) return Number(t.score) || 0;
    biased = true;
    return (Number(t.score) || 0) + Math.max(-8, Math.min(8, b.exp * 8));
  };
  list = [...list].sort((a, b) => order[phaseOf(a)] - order[phaseOf(b)] || rankScore(b) - rankScore(a));
  return (onlyBest ? "High-quality setups:\n" : `Current setups (${list.length}):\n`) + list.slice(0, 6).map(tradeBlock).join("\n") +
    (biased ? "\n\nOrder also reflects your own past results per pair (needs 10+ trades)." : "");
}

function aScan(c) {
  const sc = c.lastScan;
  if (!sc) return "No scan has been recorded yet. The next scan runs when a new 15-minute candle appears during a trading window.";
  const lines = [`Last scan: ${ago(Date.parse(sc.at))} (${eat(Date.parse(sc.at))})`];
  if (sc.skipped) lines.push(`Scan paused: ${sc.skipped}`);
  const sum = sc.summary || {};
  const syms = Object.keys(SYMBOLS);
  const found = [], forming = [], none = [];
  for (const s of syms) {
    const r = sum[s];
    if (c.mem.pauses?.[s]) { none.push(`${s}: paused by you`); continue; }
    if (c.blocked[s]) { none.push(`${s}: news pause (${c.blocked[s]})`); continue; }
    if (!r) continue;
    const old = r.at && Date.now() - Date.parse(r.at) > SCAN_STALE_MIN * 60000 ? ` (as of ${ago(Date.parse(r.at))})` : "";
    if (r.status === "LOCKED") { none.push(`${s}: open trade running`); continue; }
    if (r.status === "COOLDOWN") { none.push(`${s}: resting after its last trade`); continue; }
    if (r.status === "NEWS") { none.push(`${s}: news pause (${r.reason})`); continue; }
    if (r.status === "SETUP_FOUND") found.push(`${s} ${r.direction} (${r.timeframe}, score ${r.score})`);
    else if (r.status === "SETUP_FORMING") forming.push(`${s} ${r.direction} forming: ${plain(r.reason)}${old}`);
    else none.push(`${s}: ${plain(r.reason)}${old}`);
  }
  if (found.length) lines.push("", "Signals found:", ...found.map((x) => `• ${x}`));
  if (forming.length) lines.push("", "Forming:", ...forming.map((x) => `• ${x}`));
  if (none.length) lines.push("", "No trade:", ...none.map((x) => `• ${x}`));
  if (!found.length && !forming.length && !none.length && !sc.skipped) lines.push("Nothing recorded for the pairs yet.");
  lines.push("", `Signals today: ${c.daily} of ${DAILY_TARGET}`);
  return lines.join("\n");
}

async function aAnalyse(env, c, sym, tf) {
  const open = c.pending.filter((t) => t.symbol === sym);
  const lines = [];
  if (c.mem.pauses?.[sym]) return `${sym}\nPaused by you, so Sky is not looking for new signals on it. Say "resume ${sym}" to turn it back on.`;
  const stored = c.lastScan?.summary?.[sym];
  const at = Date.parse(stored?.at || c.lastScan?.at || "");
  const fresh = Number.isFinite(at) && Date.now() - at < SCAN_STALE_MIN * 60000;
  let r = null, source = "";

  if (stored && ["LOCKED", "COOLDOWN", "NEWS"].includes(stored.status)) {
    const text = stored.status === "LOCKED" ? "This pair already has an open trade, so Sky is not looking for another one."
      : stored.status === "COOLDOWN" ? "This pair is resting for an hour after its last trade closed."
      : `Paused for news: ${stored.reason}.`;
    return [`${sym}`, text, ...(open.length ? ["", "Open on this pair:", ...open.map(tradeBlock)] : [])].join("\n");
  }
  if (stored && fresh && (!tf || tf === stored.timeframe)) {
    r = { status: stored.status, direction: stored.direction, score: stored.score, reason: stored.reason, timeframe: stored.timeframe,
      trend: stored.trend, htf: stored.htf, zone: stored.zone, price: stored.price };
    source = `from the scan ${ago(at)}`;
  } else {
    try {
      const live = await getSignal(env, sym, tf || "M15");
      if (live?.ok) {
        const a = live.analysis || {};
        r = { status: live.status, direction: live.signal?.direction, score: live.signal?.score, reason: (live.signal?.reasons || []).at(-1),
          timeframe: tf || "M15", trend: a.trend, htf: live.htf?.trend, zone: a.dealingRange?.zone, price: live.market?.currentPrice };
        source = "live check just now";
      } else {
        const msg = live?.error;
        r = { status: "ERROR", reason: typeof msg === "string" ? msg : (msg?.message || "market data unavailable") };
        source = "live check just now";
      }
    } catch (e) {
      r = { status: "ERROR", reason: String(e?.message || e) };
    }
  }

  lines.push(`${sym} · ${r.timeframe || tf || "M15"} (${source})`);
  const verdict = r.status === "SETUP_FOUND" ? `SIGNAL ${r.direction}` :
    r.status === "SETUP_FORMING" ? `FORMING ${r.direction || ""}`.trim() : r.status === "ERROR" ? "UNAVAILABLE" : "NO TRADE";
  lines.push(`Verdict: ${verdict}${Number.isFinite(Number(r.score)) && r.score ? ` · score ${r.score}/100` : ""}`);
  if (r.status === "ERROR") lines.push(`Data problem: ${r.reason}`);
  else lines.push(`Why: ${plain(r.reason)}`);
  const ctxBits = [];
  if (r.trend) ctxBits.push(`trend ${r.trend}`);
  if (r.htf) ctxBits.push(`higher timeframe ${r.htf}`);
  if (r.zone) ctxBits.push(`price in ${r.zone}`);
  if (Number.isFinite(Number(r.price))) ctxBits.push(`price ${fx(sym, r.price)}`);
  if (ctxBits.length) lines.push(`Context: ${ctxBits.join(" · ")}`);
  if (c.blocked[sym]) lines.push(`News: paused (${c.blocked[sym]})`);
  if (open.length) lines.push("", "Open on this pair:", ...open.map(tradeBlock));
  return lines.join("\n");
}

function aPerf(c) {
  const done = c.completed;
  if (!done.length) return "No closed trades yet, so there is nothing to review.";
  const num = (t) => Number(t.r_multiple) || 0;
  const wins = done.filter((t) => t.result === "WIN").length;
  const losses = done.filter((t) => t.result === "LOSS").length;
  const netR = done.reduce((s, t) => s + num(t), 0);
  const lines = [`Last ${done.length} closed trades`];
  lines.push(`• ${wins} wins · ${losses} losses${done.length - wins - losses ? ` · ${done.length - wins - losses} breakeven` : ""}`);
  lines.push(`• Win rate ${Math.round((wins / done.length) * 100)}% · net ${signedR(netR)} · average ${signedR(netR / done.length)} per trade`);
  const by = (keyFn) => {
    const m = {};
    for (const t of done) { const k = keyFn(t); if (!k) continue; (m[k] ||= { n: 0, r: 0, w: 0 }); m[k].n++; m[k].r += num(t); if (t.result === "WIN") m[k].w++; }
    return Object.entries(m).sort((a, b) => b[1].r - a[1].r);
  };
  const pairs = by((t) => t.symbol);
  if (pairs.length > 1) {
    const best = pairs[0], worst = pairs[pairs.length - 1];
    lines.push(`• Best pair: ${best[0]} (${signedR(best[1].r)}, ${best[1].n} trades)`);
    lines.push(`• Weakest pair: ${worst[0]} (${signedR(worst[1].r)}, ${worst[1].n} trades)`);
  }
  const dirs = by((t) => t.direction);
  if (dirs.length > 1) lines.push("• " + dirs.map(([k, v]) => `${k} ${signedR(v.r)} (${v.n})`).join(" · "));
  const grades = by((t) => t.quality).filter(([, v]) => v.n >= 2);
  if (grades.length > 1) lines.push("• By grade: " + grades.map(([k, v]) => `${k} ${Math.round((v.w / v.n) * 100)}% win, ${signedR(v.r)}`).join(" · "));
  let streak = 0; const first = done[0].result;
  for (const t of done) { if (t.result === first) streak++; else break; }
  if (streak >= 2) lines.push(`• Current streak: ${streak} ${first === "WIN" ? "wins" : first === "LOSS" ? "losses" : first.toLowerCase()} in a row`);
  if (done.length < 20) lines.push("", "Small sample: treat these numbers as early signs, not proof.");
  return lines.join("\n");
}

function aNews(c) {
  const lines = [];
  if (c.cal.source === "unavailable" || !c.cal.events.length) {
    return "The economic calendar is unavailable right now, so I can't check news. Sky does not pause pairs for news until it loads again.";
  }
  const up = upcomingNews(c.cal.events, c.now, 24, 8);
  lines.push(`High-impact news in the next 24 hours (${eat(c.now)}):`);
  if (!up.length) lines.push("• None. The calendar is clear.");
  for (const n of up) lines.push(`• ${n.time}: ${n.currency} ${n.title}`);
  const bl = Object.entries(c.blocked);
  lines.push("", bl.length ? `Paused right now: ${bl.map(([k, v]) => `${k} (${v})`).join("; ")}` : "No pair is paused right now.");
  lines.push(`Rule: no new signals ${NEWS_BEFORE_MIN} min before or ${NEWS_AFTER_MIN} min after high-impact news for a pair's currencies. Open trades are not touched.`);
  return lines.join("\n");
}

function aSession(c) {
  const s = sessionAt(c.now);
  const lines = [`Now: ${SESSION_TEXT[s]} (${eat(c.now)})`];
  const open = s === "LONDON_OPEN" || s === "NY_OPEN";
  lines.push(open ? "Strict scanning is active." : "Strict signals are paused; only the relaxed tier can run, and only if you are under the daily target.");
  const nx = open ? null : nextOpenWindow(c.now);
  if (nx) lines.push(`Next prime window: ${SESSION_TEXT[nx.s]}, ${eatDay(nx.t)}.`);
  lines.push("Prime windows: London 08:00–11:00 London time and New York 08:00–11:00 New York time.");
  return lines.join("\n");
}

function aExplain(c, msg) {
  const syms = findSymbols(msg);
  let t = null;
  if (syms.length) t = c.pending.find((x) => x.symbol === syms[0] && (!/\bbuy\b/i.test(msg) || x.direction === "BUY") && (!/\bsell\b/i.test(msg) || x.direction === "SELL")) || c.pending.find((x) => x.symbol === syms[0]);
  if (!t) t = c.pending[0];
  if (!t) return "There is no active signal to explain right now.";
  const sy = t.symbol;
  const risk = Math.abs(t.entry - t.stop_loss);
  const lines = [`${sy} ${t.direction} ${t.timeframe} · ${phaseOf(t)} · grade ${t.quality || "?"}${t.score ? ` · score ${t.score}/100` : ""}`];
  lines.push(`Entry ${fx(sy, t.entry)} · stop ${fx(sy, t.stop_loss)} (${pips(sy, t.entry, t.stop_loss)} pips) · targets ${(t.take_profit || []).map((x) => fx(sy, x)).join(" / ")}`);
  const why = [...new Set([...(t.confluence || [])])].slice(0, 6);
  if (why.length) lines.push("", "Why it qualified:", ...why.map((w) => `• ${w}`));
  lines.push("", "Risks to keep in mind:");
  lines.push(`• You risk ${pips(sy, t.entry, t.stop_loss)} pips to make ${(t.take_profit || []).length ? (Math.abs(t.take_profit[0] - t.entry) / risk).toFixed(1) : "?"}R at TP1. If the stop is hit, that is a full 1R loss.`);
  if (t.watch) lines.push("• This is only a watchlist setup. Do not enter until it is confirmed.");
  else if (!t.entered) lines.push("• Price has not reached your entry yet. If it never does, the setup expires.");
  if (t.quality === "B-GRADE" || t.tier === "RELAXED") lines.push("• Lower-confidence (B-grade): use half your normal risk.");
  if (c.blocked[sy]) lines.push(`• High-impact news is close (${c.blocked[sy]}). Spreads and slippage can jump.`);
  lines.push("• Plan: close 50% at TP1, 30% at TP2, 20% at TP3, and move the stop to breakeven after TP1.");
  lines.push("", "Not financial advice.", imgMarker(t));
  return lines.join("\n");
}

function aCalc(c, msg) {
  const t = msg.toLowerCase().replace(/,/g, "");
  const syms = findSymbols(msg);
  const num = (re) => { const m = t.match(re); return m ? Number(m[1]) : null; };
  let entry = num(/entry[:\s@=]*([0-9]*\.?[0-9]+)/);
  let stop = num(/(?:stop(?: ?loss)?|sl)[:\s@=]*([0-9]*\.?[0-9]+)/);
  const balance = num(/(?:balance|account|equity)[:\s$=]*([0-9]*\.?[0-9]+)/);
  const riskPct = num(/risk[:\s=]*([0-9]*\.?[0-9]+)\s*%?/) ?? 1;
  let sym = syms[0];
  if (!sym && c.pending.length) sym = c.pending[0].symbol;
  const open = c.pending.find((p) => p.symbol === sym);
  if (open && (entry === null || stop === null)) { entry ??= open.entry; stop ??= open.stop_loss; }
  if (!sym || entry === null || stop === null || balance === null) {
    return "To size a trade I need: the pair, entry, stop and your balance. Example:\nlot size EURUSD entry 1.1000 stop 1.0980 balance 1000 risk 1%";
  }
  const ps = pipSize(sym);
  const contract = sym.includes("XAU") ? 100 : 100000;
  const pv = sym.endsWith("USD") ? contract * ps : sym.startsWith("USD") ? (contract * ps) / entry : NaN;
  const pipsRisk = Math.abs(entry - stop) / ps;
  if (!Number.isFinite(pv) || pipsRisk <= 0) return "I can't size that pair automatically (its pip value needs a conversion rate I don't have).";
  const riskAmt = balance * (riskPct / 100);
  const lots = riskAmt / (pipsRisk * pv);
  return [
    `${sym}: entry ${fx(sym, entry)}, stop ${fx(sym, stop)} (${pipsRisk.toFixed(1)} pips)`,
    `Risking ${riskPct}% of $${balance.toLocaleString("en-US")} = $${riskAmt.toFixed(2)}`,
    `Position size: about ${lots.toFixed(2)} lots`,
    "Estimate only. Check your broker's contract size and pip value. For B-grade setups use half the risk."
  ].join("\n");
}

function aGlossary(t) {
  const m = glossaryMatch(t);
  return m ? `${m[1]}\n${m[2]}` : aHelp();
}

// ---------- learning, memory and research ----------
const NEED_KEY = "To let me remember things or pause pairs, set a BRAIN_KEY secret in Cloudflare and put the same key in the app. That stops strangers from changing my memory.";

function ccysFromText(msg) {
  const up = msg.toUpperCase();
  const out = new Set();
  for (const c of ["USD", "EUR", "GBP", "JPY", "AUD", "NZD", "CAD", "CHF", "XAU"]) if (new RegExp(`\\b${c}\\b`).test(up)) out.add(c);
  const words = { DOLLAR: "USD", EURO: "EUR", POUND: "GBP", STERLING: "GBP", YEN: "JPY", AUSSIE: "AUD", KIWI: "NZD", LOONIE: "CAD", FRANC: "CHF", GOLD: "XAU" };
  for (const [w, cc] of Object.entries(words)) if (new RegExp(`\\b${w}\\b`).test(up)) out.add(cc);
  for (const s of findSymbols(msg)) {
    for (const cc of symbolCurrencies(s)) out.add(cc);
    if (s.startsWith("XAU")) out.add("XAU");
  }
  return [...out];
}

function aLessons(c) {
  const ins = insights(c.mem);
  const lines = ["What I've learned so far", ...ins.lessons.map((l) => "• " + l)];
  if (ins.suggestions.length) lines.push("", "Suggestions (you decide):", ...ins.suggestions.map((x) => "• " + x.text));
  const bits = [];
  if (c.mem.notes.length) bits.push(`${c.mem.notes.length} note(s)`);
  if (c.mem.qa.length) bits.push(`${c.mem.qa.length} Q&A`);
  if (c.mem.research.at) bits.push(`news research ${ago(Date.parse(c.mem.research.at))}`);
  if (bits.length) lines.push("", "Also in memory: " + bits.join(" · "));
  lines.push("", "I learn from your closed trades and what you teach me. I never change Sky's trading rules on my own.");
  return lines.join("\n");
}

function aHeadlines(c, msg) {
  const r = c.mem.research;
  if (!r.at) {
    return 'I have not done any news research yet. Say "research now" to fetch headlines.' +
      (r.errors?.length ? `\nLast problem: ${r.errors.join("; ")}` : "");
  }
  const want = ccysFromText(msg);
  const ccys = want.length ? want
    : Object.keys(r.tone || {}).sort((a, b) => (r.headlines[b]?.length || 0) - (r.headlines[a]?.length || 0)).slice(0, 4);
  const lines = [`News research · updated ${ago(Date.parse(r.at))} (${r.sources} source(s))`];
  for (const cc of ccys) {
    const list = headlinesFor(c.mem, cc), tn = toneFor(c.mem, cc);
    if (!list.length) { lines.push("", `${cc}: no recent headlines found.`); continue; }
    const lean = tn ? (tn.h > tn.d ? "leaning hawkish" : tn.d > tn.h ? "leaning dovish" : "mixed") : "mixed";
    lines.push("", `${cc} · ${lean}${tn ? ` (${tn.h} hawkish, ${tn.d} dovish, ${tn.n} neutral)` : ""}`);
    for (const h of list.slice(0, 3)) lines.push(`• ${h.t} (${h.s})`);
  }
  lines.push("", "Tone is a rough keyword count, not a forecast. It does not affect trading; only the economic calendar pauses pairs.");
  return lines.join("\n");
}

async function aResearch(env, c) {
  const last = c.mem.research.at ? Date.parse(c.mem.research.at) : 0;
  if (last && Date.now() - last < 10 * 60000) return `News research was refreshed ${ago(last)}. Ask for "headlines USD" to read it.`;
  const res = await runResearch(env, c.mem, { force: true });
  await saveMemory(env, c.mem);
  if (res.ok) {
    return `Done: ${res.headlines} headline(s) from ${res.sources} source(s) saved.` +
      (res.errors.length ? `\nProblems: ${res.errors.join("; ")}` : "") + '\nAsk for "headlines USD" or "news sentiment".';
  }
  return `I couldn't reach any news source (${(res.errors || []).join("; ") || "no details"}). You can set a NEWS_FEEDS variable with other RSS links.`;
}

async function aRemember(env, c, msg, auth) {
  if (!auth) return NEED_KEY;
  const text = msg.replace(/^\s*(remember( that)?|note( that)?)\s*[:\-]?\s*/i, "").trim();
  if (!text) return 'Tell me what to remember, for example: "remember: avoid trading gold on Fridays".';
  const note = addNote(c.mem, text);
  await saveMemory(env, c.mem);
  return `Saved as ${note.id}: "${note.text}"\nSay "notes" to see everything, or "forget ${note.id}" to remove it.`;
}

async function aLearn(env, c, msg, auth) {
  if (!auth) return NEED_KEY;
  const body = msg.replace(/^\s*learn\s*[:\-]?\s*/i, "").trim();
  const m = body.match(/^(.+?)\s*(?:=>|->|=)\s*([\s\S]+)$/);
  if (!m) {
    if (!body) return 'Teach me like this: "learn: what is my max daily loss => 3% of balance".';
    const note = addNote(c.mem, body);
    await saveMemory(env, c.mem);
    return `Saved as note ${note.id}. (To teach a question and answer, use: learn: question => answer)`;
  }
  const item = addQa(c.mem, m[1], m[2]);
  await saveMemory(env, c.mem);
  return `Learned ${item.id}. If you ask "${item.q}" I will answer "${item.a}".`;
}

async function aForget(env, c, msg, auth) {
  if (!auth) return NEED_KEY;
  const key = msg.replace(/^\s*forget\s*[:\-]?\s*/i, "").trim();
  if (!key) return 'Tell me what to forget: its id (like n2) or some words from it.';
  const gone = removeKnowledge(c.mem, key);
  if (!gone.length) return `I couldn't find anything matching "${key}". Say "notes" to see what I have.`;
  await saveMemory(env, c.mem);
  return `Forgot ${gone.length} item(s): ${gone.map((x) => x.id).join(", ")}.`;
}

async function aPause(env, c, msg, auth, pause) {
  if (!auth) return NEED_KEY;
  const syms = findSymbols(msg);
  if (!pause && /\ball\b/i.test(msg)) {
    resumePair(c.mem, "ALL");
    await saveMemory(env, c.mem);
    return "All pairs are active again.";
  }
  if (!syms.length) return pause ? 'Which pair? For example: "pause GBPUSD".' : 'Which pair? For example: "resume GBPUSD", or "resume all".';
  const lines = [];
  for (const s of syms) {
    if (pause) { pausePair(c.mem, s); lines.push(`${s} paused. Sky will not scan it for new signals. Open trades keep running.`); }
    else lines.push(resumePair(c.mem, s) ? `${s} is active again.` : `${s} was not paused.`);
  }
  await saveMemory(env, c.mem);
  return lines.join("\n");
}

function aPaused(c) {
  const list = Object.entries(c.mem.pauses || {});
  if (!list.length) return "No pairs are paused.";
  return "Paused by you:\n" + list.map(([s, p]) => `• ${s} (since ${eatDay(Date.parse(p.at))})`).join("\n") + '\nSay "resume <pair>" to turn one back on.';
}

function aNotes(c) {
  const { notes, qa } = c.mem;
  if (!notes.length && !qa.length) return 'I have no notes yet. Teach me with "remember: ..." or "learn: question => answer".';
  const lines = [];
  if (notes.length) lines.push("Notes:", ...notes.slice(-15).map((n) => `• ${n.id}: ${n.text}`));
  if (qa.length) lines.push(...(lines.length ? [""] : []), "Q&A:", ...qa.slice(-15).map((x) => `• ${x.id}${x.src === "ai" ? " (AI)" : ""}: ${x.q} → ${x.a}`));
  return lines.join("\n");
}

function aKnow(c, msg) {
  const q = msg.replace(/\b(what do you know( about)?|do you remember|what did i tell you( about)?)\b/gi, "").trim();
  const hit = searchKnowledge(c.mem, q || msg);
  if (hit) return `From what you taught me (${hit.id}):\n${hit.text}`;
  const g = glossaryMatch(q.toLowerCase());
  if (g) return `${g[1]}\n${g[2]}`;
  return `I haven't been taught anything about that yet. Teach me with: remember: <fact>`;
}

function aExport(c) {
  const m = c.mem;
  return [
    "My memory lives on your server, so it keeps learning even when your phone is off.",
    "The app saves a copy on your phone about every 10 minutes, and uses it when you are offline.",
    `• Server copy updated: ${m.updatedAt ? ago(Date.parse(m.updatedAt)) : "not saved yet"}`,
    `• Trades learned from: ${m.stats.total.n}`,
    `• Notes: ${m.notes.length} · Q&A: ${m.qa.length} · Paused pairs: ${Object.keys(m.pauses).length}`,
    `• News research: ${m.research.at ? ago(Date.parse(m.research.at)) : "none yet"}`
  ].join("\n");
}

// ---------- the analyst ----------
function lastSymbol(history) {
  for (let i = (history || []).length - 1; i >= 0; i--) {
    const s = findSymbols(String(history[i].content || ""))[0];
    if (s) return s;
  }
  return null;
}

async function aAnalyst(env, c, msg, syms, tf, history) {
  const got = [];
  const failed = [];
  for (const s of syms) {
    const r = await fetchBrief(env, s, tf);
    if (r.ok) got.push({ s, brief: r.brief }); else failed.push(`${s} ${tf}: ${r.error}`);
  }
  if (!got.length) {
    // live data unavailable: fall back to what the last scan recorded
    return `I couldn't load live ${tf} data (${failed.join("; ")}).\n\n` + await aAnalyse(env, c, syms[0], null);
  }
  const hint = `\n\nSay "show ${got[0].s} chart" for a marked picture.`;
  if (aiConfigured(env)) {
    try {
      const appCtx = await buildChatContext(env);
      const text = await askAI(env, { messages: reasoningMessages(got.map((g) => g.brief), msg, appCtx, history), temperature: 0.3, maxTokens: 800 });
      if (text) return text + (failed.length ? `\n\n(Could not load: ${failed.join("; ")})` : "") + "\n\n(AI reasoning on live data)" + hint;
    } catch (_) { /* fall through to the built-in report */ }
  }
  const extras = (s) => ({ blocked: c.blocked[s] || null, open: c.pending.filter((t) => t.symbol === s), paused: !!c.mem.pauses?.[s] });
  return got.map((g) => ruleReport(g.brief, extras(g.s))).join("\n\n— — —\n\n") + (failed.length ? `\n\n(Could not load: ${failed.join("; ")})` : "") + hint;
}

// ---------- pictures ----------
function pickTrade(c, sym) {
  if (sym) return c.pending.find((t) => t.symbol === sym) || c.completed.find((t) => t.symbol === sym) || null;
  return c.pending.find((t) => !t.watch) || c.pending[0] || c.completed[0] || null;
}
const imgMarker = (t) => `[[IMAGE:/api/explain-image?id=${encodeURIComponent(t.id)}]]`;

function aImage(c, msg) {
  const syms = findSymbols(msg), tf = findTf(msg);
  const t = pickTrade(c, syms[0]);
  if (t) {
    const state = t.result ? `closed ${t.result}` : phaseOf(t);
    return `Here is the marked chart for ${t.symbol} ${t.direction} ${t.timeframe} (${state}).\nEvery number on the picture is explained underneath it. Pinch to zoom.\n${imgMarker(t)}`;
  }
  if (syms[0]) {
    return `${syms[0]} has no trade right now, so here is its market map: structure, order blocks and the 50% line.\n[[IMAGE:/api/explain-image?symbol=${syms[0]}&tf=${tf || "M15"}]]`;
  }
  return 'There is no trade to draw yet. Say "show EURUSD chart" and I will draw its market map.';
}

// ---------- optional free AI helper (Gemini / Groq / Cloudflare AI) ----------
const aiConfigured = (env) => !!(env.GEMINI_API_KEY || env.GEMINI_API_KEYS || env.GROQ_API_KEY || env.GROQ_API_KEYS || env.AI);
// Only general "how does X work" questions are remembered. Anything about prices, today or your own data is not.
const educational = (q) =>
  /^(what|how|why|explain|define|difference|when|which)\b/i.test(q.trim()) && !/\d/.test(q) &&
  !/\b(now|today|current|currently|latest|right now|price|my|mine|tonight|tomorrow)\b/i.test(q) && q.length <= 160;

async function askAi(env, c, q, learn, history = []) {
  if (!aiConfigured(env)) return null;
  let res;
  try { res = await runChat(env, q, history); } catch (_) { return null; }
  const reply = String(res?.reply || "").trim();
  if (!reply || /^The AI service is unavailable|^I couldn't generate/i.test(reply)) return null;
  if (learn && educational(q) && !(history || []).length) {
    addQa(c.mem, q, reply, "ai");   // next time the brain answers this instantly, with no AI call
    await saveMemory(env, c.mem);
  }
  return reply;
}

// ---------- entry points ----------
export async function runBrain(env, message, opts = {}) {
  const msg = String(message || "").trim();
  let intent = detect(msg);
  const lower = msg.toLowerCase();
  const auth = !!opts.auth;
  const history = opts.history || [];
  // With an AI connected, open-ended questions that only matched a weak keyword ("is the stop on this trade
  // too tight?") go to the AI instead of a fixed list.
  if (aiConfigured(env) && ["signals", "status", "session"].includes(intent) && msg.split(/\s+/).length >= 6 &&
      (/\?/.test(msg) || /^(is|are|does|do|can|could|should|would|how|why|what|when|which|explain)\b/i.test(msg))) intent = "ai";
  // follow-up such as "what about 4 hour?" keeps talking about the last pair
  if (intent === "unknown" && !findSymbols(msg).length && findTf(msg) && lastSymbol(history)) intent = "analyse";
  const mem0 = await loadMemory(env);
  // Something you taught me as "learn: question => answer" beats every built-in rule.
  if (!["remember", "learn", "forget", "pause", "resume"].includes(intent)) {
    const taught = searchKnowledge(mem0, msg);
    if (taught && taught.type === "qa" && taught.score >= 0.8) {
      return { reply: taught.text + (taught.src === "ai" ? "\n\n(From memory: first answered by an AI service, so double-check anything important.)" : "") };
    }
  }

  if (intent === "greet") {
    const c = await getCtx(env, mem0);
    return { reply: "Hello! I'm Sky.\n\n" + aStatus(c) + "\n\nAsk me \"help\" to see what I can do." };
  }
  if (intent === "help") return { reply: aHelp() };
  if (intent === "thanks") return { reply: "You're welcome! Ask me anything about your setups, results or the news." };
  if (intent === "intro") return { reply: "I'm Sky's built-in brain. I read your live signals, results, scan and the economic calendar, and I answer from that data. I answer from that data first. If you connect a free AI service (Gemini or Groq), I use it only for questions I can't handle, and I remember its answers so I get faster over time.\n\n" + aHelp() };
  if (intent === "glossary") return { reply: aGlossary(lower) };

  const c = await getCtx(env, mem0);
  switch (intent) {
    case "status": return { reply: aStatus(c) };
    case "should": return { reply: aShould(c) };
    case "signals": return { reply: aSignals(c, false) };
    case "best": return { reply: aSignals(c, true) };
    case "scan": return { reply: aScan(c) };
    case "perf": return { reply: aPerf(c) };
    case "news": return { reply: aNews(c) };
    case "session": return { reply: aSession(c) };
    case "explain": return { reply: aExplain(c, msg) };
    case "calc": return { reply: aCalc(c, msg) };
    case "lessons": return { reply: aLessons(c) };
    case "headlines": return { reply: aHeadlines(c, msg) };
    case "research": return { reply: await aResearch(env, c) };
    case "remember": return { reply: await aRemember(env, c, msg, auth) };
    case "learn": return { reply: await aLearn(env, c, msg, auth) };
    case "forget": return { reply: await aForget(env, c, msg, auth) };
    case "pause": return { reply: await aPause(env, c, msg, auth, true) };
    case "resume": return { reply: await aPause(env, c, msg, auth, false) };
    case "paused": return { reply: aPaused(c) };
    case "notes": return { reply: aNotes(c) };
    case "know": return { reply: aKnow(c, msg) };
    case "export": return { reply: aExport(c) };
    case "image": return { reply: aImage(c, msg) };
    case "ai": {
      if (!aiConfigured(env)) return { reply: "No AI service is connected. Add a GEMINI_API_KEY or GROQ_API_KEY in Cloudflare to switch this on." };
      const ans = await askAi(env, c, msg.replace(/^\s*ai\s*[:\-]\s*/i, ""), true, history);
      return { reply: ans ? ans + "\n\n(answered with AI help)" : "The AI service did not answer. Please try again in a minute." };
    }
    case "analyse": {
      let syms = findSymbols(msg).slice(0, 2);
      if (!syms.length) { const hs = lastSymbol(history); if (hs) syms = [hs]; }
      if (!syms.length) return { reply: 'Which pair should I analyse? For example: "analyse gold on 1 hour".' };
      return { reply: await aAnalyst(env, c, msg, syms, findTf(msg) || "M15", history) };
    }
    default: {
      const hit = searchKnowledge(c.mem, msg);
      if (hit) return { reply: `From what you taught me (${hit.id}):\n${hit.text}` };
      const ans = await askAi(env, c, msg, true, history);
      if (ans) return { reply: ans + "\n\n(answered with AI help)" };
      return { reply: "I'm not sure what you mean by that. I'm a rule-based brain, so I answer best to the topics below.\n\n" + aHelp() };
    }
  }
}

// ---------- /chat handler (same contract the app already uses) ----------
const hits = [];
function allow() {
  const now = Date.now();
  while (hits.length && now - hits[0] > 60000) hits.shift();
  if (hits.length >= 30) return false;
  hits.push(now);
  return true;
}

export async function handleBrainChat(request, env) {
  const headers = { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" };
  const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers });
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: { ...headers, "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, X-Sky-Key" } });
  }
  if (request.method !== "POST") return out({ error: "Use POST" }, 405);
  let body;
  try { body = await request.json(); } catch (_) { return out({ error: "Invalid JSON" }, 400); }
  const message = String(body?.message ?? "").trim().slice(0, 1000);
  if (!message) return out({ error: "Empty message" }, 400);
  if (!allow()) return out({ reply: "Too many messages. Please wait a minute and try again." });
  const history = Array.isArray(body?.history)
    ? body.history.slice(-8).map((h) => ({ role: h?.role === "assistant" ? "assistant" : "user", content: String(h?.content ?? "").slice(0, 700) }))
    : [];
  try {
    const auth = !!env.BRAIN_KEY && request.headers.get("X-Sky-Key") === env.BRAIN_KEY;
    return out(await runBrain(env, message, { auth, history }));
  } catch (e) {
    console.error("Brain error:", e);
    return out({ reply: "Something went wrong while reading the data. Please try again." });
  }
}
