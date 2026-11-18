// ============================================================
// SKY AI — MEMORY
// Everything the brain learns lives here, in ONE Cloudflare KV key ("brain_memory").
// It keeps growing from four sources, and never changes your trading rules by itself:
//   1. Results   : every closed trade updates statistics (pair, direction, session, grade, hour...)
//   2. Teaching  : notes and Q&A you add in chat ("remember ...", "learn: question => answer")
//   3. Research  : news headlines pulled from RSS feeds, tagged by currency with a rough tone
//   4. Choices   : pairs you pause or resume
// KV budget (free plan): 1,000 writes/day. This file adds roughly 30 a day.
// ============================================================

const KEY = "brain_memory";
const TZ = "Africa/Nairobi";
const MAX_SEEN = 300;
const MAX_NOTES = 100;
const MAX_QA = 60;
const HEADLINES_PER_CCY = 8;
const MIN_SAMPLE = 8;                    // a group needs this many trades before I draw conclusions
const RESEARCH_MIN_GAP_MS = 10 * 60000;

// Free RSS feeds. Override with a NEWS_FEEDS variable (comma-separated URLs) if one stops working.
const DEFAULT_FEEDS = [
  "https://www.forexlive.com/feed/news",
  "https://www.fxstreet.com/rss/news"
];

const bucket = () => ({ n: 0, w: 0, l: 0, r: 0 });
const empty = () => ({
  v: 1, updatedAt: null, seen: [],
  stats: { total: bucket(), byPair: {}, byDir: {}, byTf: {}, byGrade: {}, bySession: {}, byHour: {} },
  notes: [], qa: [], pauses: {},
  research: { at: null, sources: 0, headlines: {}, tone: {}, errors: [] }
});

// ---------- load / save ----------
export async function loadMemory(env) {
  const base = empty();
  try {
    const raw = await env.SKY_MEMORY?.get(KEY);
    if (!raw) return base;
    const m = JSON.parse(raw);
    return {
      ...base, ...m,
      stats: { ...base.stats, ...(m.stats || {}), total: { ...bucket(), ...(m.stats?.total || {}) } },
      research: { ...base.research, ...(m.research || {}) },
      seen: Array.isArray(m.seen) ? m.seen : [],
      notes: Array.isArray(m.notes) ? m.notes : [],
      qa: Array.isArray(m.qa) ? m.qa : [],
      pauses: m.pauses && typeof m.pauses === "object" ? m.pauses : {}
    };
  } catch (_) {
    return base;
  }
}

export async function saveMemory(env, mem) {
  mem.updatedAt = new Date().toISOString();
  mem.seen = mem.seen.slice(-MAX_SEEN);
  mem.notes = mem.notes.slice(-MAX_NOTES);
  mem.qa = mem.qa.slice(-MAX_QA);
  try {
    await env.SKY_MEMORY.put(KEY, JSON.stringify(mem));
    return true;
  } catch (e) {
    console.error("saveMemory failed:", e?.message || e);
    return false;
  }
}

// ---------- 1. learning from results ----------
function eatHour(iso) {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  const h = new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(ms));
  return String(Number(h)).padStart(2, "0");
}

function add(map, key, r, result) {
  if (!key) return;
  const b = (map[key] ||= bucket());
  b.n++; b.r += r;
  if (result === "WIN") b.w++; else if (result === "LOSS") b.l++;
}

/** Adds closed trades that haven't been learned yet. Safe to call repeatedly with the same trades. */
export function learnFromTrades(mem, trades) {
  let added = 0;
  for (const t of trades || []) {
    if (!t || !t.id || mem.seen.includes(t.id)) continue;
    if (t.result !== "WIN" && t.result !== "LOSS" && t.result !== "BREAKEVEN") continue;
    const r = Number(t.r_multiple);
    const rr = Number.isFinite(r) ? r : 0;
    const s = mem.stats;
    add({ total: s.total }, "total", rr, t.result);
    add(s.byPair, t.symbol, rr, t.result);
    add(s.byDir, t.direction, rr, t.result);
    add(s.byTf, t.timeframe, rr, t.result);
    add(s.byGrade, t.quality || t.tier, rr, t.result);
    add(s.bySession, t.session, rr, t.result);
    add(s.byHour, eatHour(t.created_at), rr, t.result);
    mem.seen.push(t.id);
    added++;
  }
  return added;
}

const exp = (b) => (b.n ? b.r / b.n : 0);
const pct = (b) => (b.n ? Math.round((b.w / b.n) * 100) : 0);
const sr = (r) => `${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(1)}R`;
const nice = (k) => String(k).replaceAll("_", " ").toLowerCase();

/** Plain-language lessons from the statistics. Only groups with enough trades are judged. */
export function insights(mem) {
  const t = mem.stats.total;
  const out = { total: t, lessons: [], suggestions: [], ready: t.n >= MIN_SAMPLE };
  if (t.n < MIN_SAMPLE) {
    out.lessons.push(`I have only learned from ${t.n} closed trade(s) so far. I need at least ${MIN_SAMPLE} in a group before I draw conclusions.`);
    return out;
  }
  out.lessons.push(`Overall: ${t.n} trades, ${pct(t)}% wins, ${sr(t.r)} net (${sr(exp(t))} per trade).`);

  const dims = [
    ["pair", mem.stats.byPair, (k) => k],
    ["direction", mem.stats.byDir, (k) => k],
    ["session", mem.stats.bySession, nice],
    ["grade", mem.stats.byGrade, (k) => k],
    ["timeframe", mem.stats.byTf, (k) => k]
  ];
  for (const [name, map, label] of dims) {
    const rows = Object.entries(map).filter(([, b]) => b.n >= MIN_SAMPLE).sort((a, b) => exp(b[1]) - exp(a[1]));
    if (!rows.length) continue;
    const best = rows[0];
    out.lessons.push(`Best ${name}: ${label(best[0])} (${sr(best[1].r)} over ${best[1].n}, ${pct(best[1])}% wins).`);
    if (rows.length > 1) {
      const worst = rows[rows.length - 1];
      if (exp(worst[1]) < exp(best[1])) out.lessons.push(`Weakest ${name}: ${label(worst[0])} (${sr(worst[1].r)} over ${worst[1].n}, ${pct(worst[1])}% wins).`);
    }
  }
  const hours = Object.entries(mem.stats.byHour).filter(([, b]) => b.n >= MIN_SAMPLE).sort((a, b) => exp(b[1]) - exp(a[1]));
  if (hours.length) out.lessons.push(`Best entry hour (EAT): ${hours[0][0]}:00 (${sr(hours[0][1].r)} over ${hours[0][1].n}).`);

  for (const [sym, b] of Object.entries(mem.stats.byPair)) {
    if (b.n >= 10 && exp(b) <= -0.25 && b.r <= -3 && !mem.pauses[sym]) {
      out.suggestions.push({
        symbol: sym,
        text: `${sym} has lost ${sr(b.r)} over ${b.n} trades (${pct(b)}% wins). Say "pause ${sym}" to stop new signals on it.`
      });
    }
  }
  return out;
}

/** Past performance of a pair, used only to nudge the ranking. Null until there are 10+ trades. */
export function pairBias(mem, symbol) {
  const b = mem.stats.byPair[symbol];
  return b && b.n >= 10 ? { n: b.n, exp: exp(b) } : null;
}

// ---------- 2. teaching ----------
const STOP = new Set(["the", "and", "for", "are", "was", "you", "your", "what", "how", "why", "when", "that", "this", "with", "have", "has",
  "about", "tell", "know", "does", "did", "can", "from", "into", "not", "but", "will", "would", "should", "could", "there", "their", "them"]);
const tokens = (s) => String(s).toLowerCase().replace(/[^a-z0-9\s]/g, " ").split(/\s+/).filter((w) => w.length > 2 && !STOP.has(w));
const newId = (prefix, list) => {
  const max = list.reduce((m, x) => Math.max(m, Number(String(x.id).replace(/\D/g, "")) || 0), 0);
  return `${prefix}${max + 1}`;
};

export function addNote(mem, text) {
  const t = String(text || "").trim().slice(0, 300);
  if (!t) return null;
  const dup = mem.notes.find((n) => n.text.toLowerCase() === t.toLowerCase());
  if (dup) return dup;
  const note = { id: newId("n", mem.notes), text: t, at: new Date().toISOString() };
  mem.notes.push(note);
  return note;
}

const MAX_AI_QA = 40;

/** src = "user" (you taught it) or "ai" (an AI service answered it first; kept so the next ask is instant). */
export function addQa(mem, q, a, src = "user") {
  const question = String(q || "").trim().slice(0, 200), answer = String(a || "").trim().slice(0, src === "ai" ? 700 : 400);
  if (!question || !answer) return null;
  const existing = mem.qa.find((x) => x.q.toLowerCase() === question.toLowerCase());
  if (existing) { if (src === "user" || existing.src === "ai") { existing.a = answer; existing.src = src; } return existing; }
  const item = { id: newId("q", mem.qa), q: question, a: answer, src, at: new Date().toISOString() };
  mem.qa.push(item);
  const ai = mem.qa.filter((x) => x.src === "ai");
  if (ai.length > MAX_AI_QA) { const drop = ai[0].id; mem.qa = mem.qa.filter((x) => x.id !== drop); }
  return item;
}

/** Forget by id (n3, q2) or by words inside the text. Returns what was removed. */
export function removeKnowledge(mem, key) {
  const k = String(key || "").trim().toLowerCase();
  if (!k) return [];
  const removed = [];
  const keep = (list, textOf) => list.filter((x) => {
    const hit = x.id.toLowerCase() === k || textOf(x).toLowerCase().includes(k);
    if (hit) removed.push(x);
    return !hit;
  });
  mem.notes = keep(mem.notes, (x) => x.text);
  mem.qa = keep(mem.qa, (x) => x.q);
  return removed;
}

/** Finds taught knowledge that matches a question. */
export function searchKnowledge(mem, query) {
  const qt = new Set(tokens(query));
  if (!qt.size) return null;
  let best = null;
  for (const item of mem.qa) {
    const it = new Set(tokens(item.q));
    const common = [...it].filter((w) => qt.has(w)).length;
    const score = common / Math.max(1, Math.min(it.size, qt.size));
    if (common >= 1 && score >= 0.6 && (!best || score > best.score)) best = { type: "qa", text: item.a, id: item.id, score, src: item.src || "user" };
  }
  if (best) return best;
  for (const n of mem.notes) {
    const nt = new Set(tokens(n.text));
    const common = [...qt].filter((w) => nt.has(w)).length;
    const score = common / qt.size;
    if (common >= 1 && score >= 0.5 && (!best || score > best.score)) best = { type: "note", text: n.text, id: n.id, score };
  }
  return best;
}

// ---------- 3. choices ----------
export function pausePair(mem, symbol, reason = "paused by you") {
  mem.pauses[symbol] = { at: new Date().toISOString(), reason };
}
export function resumePair(mem, symbol) {
  if (symbol === "ALL") { mem.pauses = {}; return true; }
  const had = !!mem.pauses[symbol];
  delete mem.pauses[symbol];
  return had;
}

// ---------- 4. research (news headlines) ----------
const CCY_WORDS = {
  USD: [" fed ", " fomc ", " powell ", " dollar ", " u.s. ", " us ", " treasury ", " nonfarm ", " payrolls ", " nfp "],
  EUR: [" ecb ", " euro ", " eurozone ", " lagarde ", " german ", " germany "],
  GBP: [" boe ", " bank of england ", " sterling ", " pound ", " gbp ", " bailey ", " uk "],
  JPY: [" boj ", " yen ", " ueda ", " japan ", " japanese "],
  AUD: [" rba ", " aussie ", " australia ", " australian ", " aud "],
  NZD: [" rbnz ", " kiwi ", " new zealand ", " nzd "],
  CAD: [" boc ", " loonie ", " canada ", " canadian ", " cad "],
  CHF: [" snb ", " franc ", " swiss ", " chf "],
  XAU: [" gold ", " xau ", " bullion "]
};
const HAWKISH = ["hike", "hikes", "hawkish", "tightening", "higher for longer", "hotter", "stronger than expected", "beats expectations", "above expectations"];
const DOVISH = ["cut", "cuts", "dovish", "easing", "softer", "weaker than expected", "misses expectations", "below expectations", "slowdown", "recession"];

function decode(s) {
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/&#39;|&#x27;|&apos;/g, "'").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ").trim();
}

export function parseRss(xml) {
  const items = [];
  const blocks = String(xml).match(/<item[\s>][\s\S]*?<\/item>/gi) || [];
  for (const b of blocks.slice(0, 40)) {
    const pick = (tag) => { const m = b.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i")); return m ? decode(m[1]) : ""; };
    const title = pick("title");
    if (!title) continue;
    const ms = Date.parse(pick("pubDate"));
    items.push({ title: title.slice(0, 160), link: pick("link").slice(0, 300), ms: Number.isFinite(ms) ? ms : null });
  }
  return items;
}

export function classify(title) {
  const n = " " + String(title).toLowerCase().replace(/[^a-z0-9.$/ ]/g, " ").replace(/\s+/g, " ") + " ";
  const ccys = Object.entries(CCY_WORDS).filter(([, words]) => words.some((w) => n.includes(w))).map(([c]) => c);
  const h = HAWKISH.some((w) => n.includes(" " + w + " ") || n.includes(" " + w));
  const d = DOVISH.some((w) => n.includes(" " + w + " ") || n.includes(" " + w));
  const tone = h && !d ? 1 : d && !h ? -1 : 0;
  return { ccys, tone };
}

async function fetchText(url, timeoutMs = 8000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: c.signal, headers: { "User-Agent": "Mozilla/5.0 (SkyAI)", "Accept": "application/rss+xml, application/xml, text/xml" } });
    if (!res.ok) throw new Error("HTTP " + res.status);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

/** Pulls headlines, tags them by currency and rough tone, keeps the newest few per currency. */
export async function runResearch(env, mem, { force = false } = {}) {
  const now = Date.now();
  const last = mem.research.at ? Date.parse(mem.research.at) : 0;
  if (!force && now - last < RESEARCH_MIN_GAP_MS) return { skipped: true, at: mem.research.at };

  const feeds = String(env.NEWS_FEEDS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const urls = feeds.length ? feeds : DEFAULT_FEEDS;
  const errors = [];
  let all = [];
  let ok = 0;
  for (const url of urls) {
    try {
      const items = parseRss(await fetchText(url));
      if (!items.length) throw new Error("no items");
      const host = new URL(url).hostname.replace(/^www\./, "");
      all = all.concat(items.map((i) => ({ ...i, src: host })));
      ok++;
    } catch (e) {
      errors.push(`${new URL(url).hostname}: ${e?.message || e}`);
    }
  }
  if (!ok) {
    mem.research.errors = errors;
    return { ok: false, errors };
  }

  const cutoff = now - 48 * 3600000;
  const seenTitles = new Set();
  const headlines = {};
  const tone = {};
  all.sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0));
  for (const it of all) {
    if (it.ms && it.ms < cutoff) continue;
    const key = it.title.toLowerCase().slice(0, 80);
    if (seenTitles.has(key)) continue;
    seenTitles.add(key);
    const { ccys, tone: tn } = classify(it.title);
    for (const c of ccys) {
      const list = (headlines[c] ||= []);
      if (list.length < HEADLINES_PER_CCY) list.push({ t: it.title, s: it.src, u: it.link, ms: it.ms });
      const tt = (tone[c] ||= { h: 0, d: 0, n: 0 });
      if (tn > 0) tt.h++; else if (tn < 0) tt.d++; else tt.n++;
    }
  }
  mem.research = { at: new Date(now).toISOString(), sources: ok, headlines, tone, errors };
  return { ok: true, sources: ok, headlines: Object.values(headlines).reduce((s, l) => s + l.length, 0), errors };
}

export const headlinesFor = (mem, ccy) => mem.research.headlines?.[ccy] || [];
export const toneFor = (mem, ccy) => mem.research.tone?.[ccy] || null;

// ---------- export (for the app to keep a copy on the phone) ----------
export function exportBrain(mem) {
  const ins = insights(mem);
  const headlines = {};
  for (const [c, list] of Object.entries(mem.research.headlines || {})) headlines[c] = list.slice(0, 5).map((h) => ({ t: h.t, s: h.s }));
  return {
    ok: true,
    updatedAt: mem.updatedAt,
    learnedFrom: mem.stats.total.n,
    totals: mem.stats.total,
    lessons: ins.lessons,
    suggestions: ins.suggestions.map((s) => s.text),
    notes: mem.notes.slice(-20).map((n) => ({ id: n.id, text: n.text })),
    qa: mem.qa.slice(-20).map((q) => ({ id: q.id, q: q.q, a: q.a })),
    pauses: Object.keys(mem.pauses),
    research: { at: mem.research.at, headlines, tone: mem.research.tone || {} }
  };
}
