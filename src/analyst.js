// ============================================================
// SKY AI — ANALYST
// Builds a "brief" from the engine's LIVE analysis of a pair, then reasons about it in two ways:
//   1. ruleReport()        : a built-in analyst report (bias, structure, levels, checklist, scenarios).
//                            Works with no AI service at all.
//   2. reasoningMessages() : the same brief packaged for a free AI (Gemini / Groq) so it can reason
//                            flexibly about any question, using ONLY these facts.
// ============================================================
import { getSignal } from "./engine.js";

const digits = (s) => (String(s).startsWith("XAU") ? 2 : String(s).endsWith("JPY") ? 3 : 5);
const pipSize = (s) => (String(s).includes("JPY") ? 0.01 : String(s).includes("XAU") ? 0.1 : 0.0001);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };

// ---------- plain-language reasons (shared with the brain and the pictures) ----------
const REASONS = [
  [/outside prime|not allowed in|session .* not allowed/i, "It's outside the trading windows (London and New York open)."],
  [/higher-timeframe trend unavailable/i, "The higher timeframe has no clear trend, or its data could not be loaded."],
  [/conflicts with HTF/i, "The trend on this timeframe disagrees with the higher timeframe."],
  [/no recent BOS/i, "There has been no fresh break of structure in the trend direction."],
  [/no recent liquidity sweep/i, "No liquidity sweep has happened before the move yet."],
  [/events out of order/i, "The sequence (sweep, then structure break, then order block) is not in the right order."],
  [/no fresh unmitigated order block|no fresh/i, "There is no fresh order block near price. Price is either far from one or the block was already used."],
  [/premium half/i, "Price is in the premium half of the range, so buys are not allowed here."],
  [/discount half/i, "Price is in the discount half of the range, so sells are not allowed here."],
  [/dealing range/i, "There is no usable price range yet to judge premium/discount."],
  [/below the .* minimum/i, "A setup exists but its score is too low to qualify."],
  [/obstacle|sits between entry and TP1/i, "A nearby level leaves too little room to the first target."],
  [/stop is .* ATR/i, "The stop would need to be too wide to be safe."],
  [/waiting for price to retest/i, "A setup is forming. Price has not reached the order block yet."],
  [/stronger confirming candle|waiting for a confirming/i, "Price is at the order block. Sky is waiting for a strong confirming candle."],
  [/stale/i, "Market data is stale, so signals are paused for safety."],
  [/exposure|same-side trades/i, "Blocked to avoid stacking too many trades on one currency."],
  [/cooldown/i, "This setup already produced a signal recently."],
  [/already has an active trade/i, "This pair already has an open trade."],
  [/Filters passed/i, "All filters passed and the entry candle confirmed."],
  [/market structure is neutral|neutral/i, "The market has no clear trend right now."]
];
export function plainReason(reason) {
  const r = String(reason || "");
  for (const [re, text] of REASONS) if (re.test(r)) return text;
  return r.replace(/^Rejected:\s*/i, "") || "No reason recorded.";
}

// ---------- the brief ----------
export function buildBrief(symbol, tf, payload) {
  const a = payload.analysis || {};
  const d = digits(symbol), ps = pipSize(symbol);
  const r = (v) => (num(v) === null ? null : Number(Number(v).toFixed(d)));
  const lastIdx = (a.candlesAnalysed || 1) - 1;
  const price = num(payload.market?.currentPrice) ?? num(a.lastClosedCandle?.close);
  const atr = num(a.atr?.value) || 0;
  const ago = (i) => (Number.isInteger(i) ? lastIdx - i : null);
  const pipsFrom = (v) => (price === null ? null : Number(((v - price) / ps).toFixed(0)));
  const gapTo = (o) => (price < o.bottom ? o.bottom - price : price > o.top ? price - o.top : 0);

  const rg = a.dealingRange?.valid ? a.dealingRange : null;
  const sig = payload.signal || {};
  const brief = {
    symbol, timeframe: tf, price: r(price), atr: r(atr), atrPips: atr ? Number((atr / ps).toFixed(1)) : null,
    trend: a.trend || "unknown", higherTimeframe: payload.htf?.timeframe || null, higherTimeframeTrend: payload.htf?.trend || null,
    session: sig.session || null,
    range: rg ? {
      low: r(rg.low), high: r(rg.high), equilibrium: r(rg.equilibrium),
      zone: rg.zone || (price === null ? null : price > rg.equilibrium ? "premium" : price < rg.equilibrium ? "discount" : "equilibrium"),
      positionPercent: rg.high > rg.low && price !== null ? Math.round(((price - rg.low) / (rg.high - rg.low)) * 100) : null
    } : null,
    structure: (a.structureEvents || []).slice(-3).map((e) => ({ type: e.type, direction: e.direction, level: r(e.level), candlesAgo: ago(e.index) })),
    sweeps: (a.sweeps || []).slice(-3).map((s) => ({ direction: s.direction, level: r(s.level), candlesAgo: ago(s.index) })),
    orderBlocks: (a.orderBlocks || []).filter((o) => o.status !== "invalidated")
      .sort((x, y) => gapTo(x) - gapTo(y)).slice(0, 4)
      .map((o) => ({ direction: o.direction, bottom: r(o.bottom), top: r(o.top), status: o.status, pipsFromPrice: Math.round(gapTo(o) / ps), candlesOld: ago(o.candleIndex) })),
    fairValueGaps: (a.fvg || []).filter((f) => f.status !== "filled").slice(-3)
      .map((f) => ({ direction: f.direction, bottom: r(f.bottom), top: r(f.top), status: f.status, candlesOld: ago(f.index) })),
    equalLevels: (a.liquidityPools || []).filter((p) => p.kind === "equal" && p.status === "unswept")
      .sort((x, y) => Math.abs(x.level - price) - Math.abs(y.level - price)).slice(0, 3)
      .map((p) => ({ type: p.side === "buy" ? "equal highs" : "equal lows", level: r(p.level), pipsFromPrice: pipsFrom(p.level) })),
    previousDay: a.levels?.previousDay?.complete ? { high: r(a.levels.previousDay.high), low: r(a.levels.previousDay.low) } : null,
    engine: {
      decision: sig.decision || "NO_TRADE", watch: !!sig.watch, entryStatus: sig.entryStatus || null, score: sig.score ?? null,
      why: plainReason((sig.reasons || []).at(-1)),
      levels: sig.levels ? { entry: r(sig.levels.entry), stop: r(sig.levels.stop_loss), targets: (sig.levels.take_profit || []).map(r) } : null
    }
  };
  return brief;
}

export async function fetchBrief(env, symbol, tf) {
  let payload;
  try {
    payload = await getSignal(env, symbol, tf);
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
  if (!payload?.ok) {
    const why = typeof payload?.error === "string" ? payload.error : payload?.error?.message || "market data unavailable";
    return { ok: false, error: why };
  }
  return { ok: true, brief: buildBrief(symbol, tf, payload), payload };
}

// ---------- built-in analyst report ----------
export function ruleReport(b, extras = {}) {
  const { blocked = null, open = [], paused = false } = extras;
  const d = digits(b.symbol), fx = (v) => Number(v).toFixed(d);
  const tfName = b.timeframe, htf = b.higherTimeframeTrend;
  const L = [];

  // bias with the reasoning behind it
  let bias, biasWhy;
  if (b.trend === "bullish" || b.trend === "bearish") {
    if (htf === b.trend) { bias = b.trend.toUpperCase(); biasWhy = `${tfName} structure and the ${b.higherTimeframe || "higher"} timeframe both read ${b.trend}.`; }
    else if (htf && htf !== "neutral") { bias = "MIXED"; biasWhy = `${tfName} reads ${b.trend} but the ${b.higherTimeframe} timeframe reads ${htf}, so the picture conflicts.`; }
    else { bias = b.trend.toUpperCase() + " (unconfirmed)"; biasWhy = `${tfName} reads ${b.trend}, but the higher timeframe gives no clear confirmation.`; }
  } else { bias = "NO CLEAR BIAS"; biasWhy = "The market has no clean trend on this timeframe right now."; }
  L.push(`${b.symbol} · ${tfName} · price ${fx(b.price)}`);
  L.push(`Bias: ${bias}. ${biasWhy}`);

  // structure story
  const le = b.structure.at(-1);
  if (le) {
    L.push(`Structure: the last break was a ${le.type === "CHOCH" ? "change of character" : "break of structure"} ${le.direction === "bullish" ? "up" : "down"} through ${fx(le.level)}, ${le.candlesAgo === 0 ? "on the latest candle" : le.candlesAgo + " candles ago"}.`);
  }
  const ls = b.sweeps.at(-1);
  if (ls) L.push(`Liquidity: price swept ${ls.direction === "bullish" ? "the lows" : "the highs"} at ${fx(ls.level)} ${ls.candlesAgo} candles ago, a ${ls.direction} sign.`);

  // location
  if (b.range) {
    const p = b.range.positionPercent;
    const where = p < 0 ? "below the whole range" : p > 100 ? "above the whole range" : `${p}% up the range`;
    L.push(`Location: price is ${where} (${fx(b.range.low)} to ${fx(b.range.high)}), in the ${b.range.zone || "middle"}. ` +
      `${b.range.zone === "discount" ? "That is the cheap half: buys are allowed, sells are not." : b.range.zone === "premium" ? "That is the expensive half: sells are allowed, buys are not." : ""}`.trim());
  }

  // zones
  const ob = b.orderBlocks[0];
  if (ob) L.push(`Nearest order block: ${ob.direction} ${fx(ob.bottom)}–${fx(ob.top)} (${ob.status === "unmitigated" ? "untouched" : "already tapped"}, ${ob.pipsFromPrice} pips away).`);
  if (b.fairValueGaps.length) L.push(`Open gap: ${b.fairValueGaps.at(-1).direction} ${fx(b.fairValueGaps.at(-1).bottom)}–${fx(b.fairValueGaps.at(-1).top)}.`);
  const magnets = [...b.equalLevels.map((e) => `${e.type} ${fx(e.level)}`), ...(b.previousDay ? [`previous day high ${fx(b.previousDay.high)}`, `previous day low ${fx(b.previousDay.low)}`] : [])];
  if (magnets.length) L.push(`Liquidity magnets: ${magnets.join(", ")}.`);

  // Sky's checklist (a quick independent read of the same rules the engine uses)
  const dir = b.trend === "bullish" || b.trend === "bearish" ? b.trend : null;
  const check = [];
  const sess = b.session || "";
  check.push([/LONDON_OPEN|NY_OPEN/.test(sess), `Prime session${sess ? ` (${sess.toLowerCase().replaceAll("_", " ")})` : ""}`]);
  check.push([!!dir && htf === dir, "Higher timeframe agrees"]);
  check.push([!!dir && b.structure.some((e) => e.direction === dir && e.candlesAgo <= 30), "Fresh structure break in the trend direction"]);
  check.push([!!dir && b.sweeps.some((s) => s.direction === dir && s.candlesAgo <= 25), "Liquidity sweep before the move"]);
  const freshNear = b.orderBlocks.some((o) => o.direction === dir && o.status !== "invalidated" && o.pipsFromPrice <= (b.atrPips || 10));
  check.push([!!dir && freshNear, "Fresh order block within 1 ATR of price"]);
  check.push([!!dir && ((dir === "bullish" && b.range?.zone === "discount") || (dir === "bearish" && b.range?.zone === "premium")), "Price in the right half of the range"]);
  L.push("", "Sky's checklist:", ...check.map(([ok, t]) => `${ok ? "✅" : "❌"} ${t}`));

  // verdict + what must happen next
  const e = b.engine;
  L.push("");
  if (e.decision === "BUY" || e.decision === "SELL") {
    L.push(`Verdict: ${e.decision} setup (score ${e.score}). ${e.why}`);
    if (e.levels) L.push(`Plan: entry ${fx(e.levels.entry)}, stop ${fx(e.levels.stop)}, targets ${e.levels.targets.map(fx).join(" / ")}.`);
  } else if (e.watch) {
    L.push(`Verdict: setup forming. ${e.why}`);
  } else {
    L.push(`Verdict: NO TRADE. ${e.why}`);
  }
  if (!(e.decision === "BUY" || e.decision === "SELL") && dir) {
    const wantBlock = dir === "bullish" ? "bullish" : "bearish";
    const target = b.orderBlocks.find((o) => o.direction === wantBlock && o.status === "unmitigated");
    L.push(target
      ? `Waiting for: price to ${dir === "bullish" ? "pull back down" : "rally up"} into the ${wantBlock} block ${fx(target.bottom)}–${fx(target.top)}, then a strong ${wantBlock} candle.`
      : `Waiting for: a fresh ${wantBlock} order block to form after a sweep and structure break.`);
  }

  // two-sided scenarios from real levels
  const lv = [];
  for (const o of b.orderBlocks) lv.push({ v: o.top, t: `${o.direction} block top` }, { v: o.bottom, t: `${o.direction} block bottom` });
  for (const x of b.equalLevels) lv.push({ v: x.level, t: x.type });
  if (b.previousDay) lv.push({ v: b.previousDay.high, t: "previous day high" }, { v: b.previousDay.low, t: "previous day low" });
  if (b.range) lv.push({ v: b.range.high, t: "range high" }, { v: b.range.low, t: "range low" });
  const up = lv.filter((x) => x.v > b.price).sort((x, y) => x.v - y.v)[0];
  const dn = lv.filter((x) => x.v < b.price).sort((x, y) => y.v - x.v)[0];
  if (up || dn) {
    L.push("", "Scenarios:");
    if (up) L.push(`• Bullish: a strong close above ${fx(up.v)} (${up.t}) shows buyers gaining strength.`);
    if (dn) L.push(`• Bearish: a strong close below ${fx(dn.v)} (${dn.t}) shows sellers gaining strength.`);
  }

  if (paused) L.push("", "Note: you paused this pair, so Sky is not scanning it for signals.");
  if (blocked) L.push("", `News: high-impact event close (${blocked}). Sky pauses this pair around it.`);
  if (open.length) L.push("", `Open trade on this pair: ${open.map((t) => `${t.direction} entry ${fx(t.entry)}`).join(", ")}.`);
  L.push("", "Not financial advice.");
  return L.join("\n");
}

// ---------- the same brief, packaged for an AI to reason about ----------
export function reasoningMessages(briefs, question, appContext, history = []) {
  const system = `You are Sky, a senior Smart Money Concepts (SMC) analyst inside a forex and gold trading app. Reason like a careful professional.

STRICT RULES
- Use ONLY the DATA BRIEF and APP DATA below. They come from the live engine. If something is not in them, say you don't have it. Never invent prices, levels, news, or outcomes.
- Think it through: what is the bias and why, what does the structure say, where are the liquidity and order blocks, what must happen next, and what would invalidate the idea.
- Compare the engine's verdict with your own reading. If you would judge it differently, say so and explain why.
- Give a bullish and a bearish scenario using real levels from the brief.
- Be flexible: answer the actual question asked (a stop-loss question, a comparison, a "should I wait" question), not a fixed template.
- Sky's signal rules: trade only at the London/New York open, with the higher timeframe agreeing, a fresh break of structure, a liquidity sweep, a fresh order block near price, and buys only in discount / sells only in premium. B-grade setups use half risk.
- Plain text only: no markdown, no asterisks. Under 230 words unless asked for detail. End trade ideas with one short line that this is not financial advice.`;
  const user = `QUESTION: ${question}\n\nDATA BRIEF (live):\n${JSON.stringify(briefs)}\n\nAPP DATA:\n${appContext || "none"}`;
  const hist = (history || []).slice(-6).map((h) => ({ role: h.role === "assistant" ? "assistant" : "user", content: String(h.content || "").slice(0, 700) }));
  return [{ role: "system", content: system }, ...hist, { role: "user", content: user }];
}
