// ======================================================
// SKY AI - SIGNAL ENGINE v3.0.0 (single file)
// Replaces src/engine.js. Contains:
//   Part 1: decision engine (strict + relaxed tiers, lifecycle tracker)
//   Part 2: data loading, per-symbol analysis, and the all-pairs scanner
// Exports: scanAll, runScanner, getSignal, runSignalEngine,
//          evaluateSetup, buildChartAnnotations, SignalTracker, getTradingSession
// ======================================================
import { SYMBOLS, TIMEFRAMES } from "./market/symbols.js";
import { getMarketData, assessFreshness } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";

// ######################################################
// PART 1: DECISION ENGINE
// ######################################################
const MAX_ZONE_DISTANCE_ATR = 1.0;
const MAX_EVENT_AGE = 30;
const MAX_SWEEP_AGE = 25;
const MIN_STOP_ATR = 1.5;
const MAX_STOP_ATR = 3.0;
const STOP_BUFFER_ATR = 0.2;
const TP_R_MULTIPLES = [2, 3, 4];
const MIN_TP1_R = 1.5;               // after capping by obstacles, TP1 must still be >= 1.5R
const TARGET_BUFFER_ATR = 0.1;       // stop TPs slightly before an obstacle

// Daily quota
const MIN_DAILY_SIGNALS = 3;
const DAY_TIME_ZONE = "Africa/Nairobi";   // defines when "a day" starts/ends (EAT)
const RELAX_AFTER_LONDON_HOUR = 9;        // relaxed tier unlocks after 09:00 London if under quota

// Lifecycle
const WATCH_EXPIRY_CANDLES = 12;     // "watch" setups die after this many candles
const COOLDOWN_CANDLES = 40;         // no repeat signal on the same order block
const DEFAULT_CANDLE_MS = 15 * 60 * 1000;

// Confirmation candle
const REJECTION_WICK_RATIO = 0.5;    // wick must be >= 50% of the candle range

const PROFILES = {
  strict: {
    minScore: 95, killzonesOnly: true, requireSweep: true, requireSequence: true,
    rejectOnOpposingZone: true, minBodyATR: 0.5, strongConfirm: true, riskScale: 1
  },
  relaxed: {
    minScore: 75, killzonesOnly: false, requireSweep: false, requireSequence: false,
    rejectOnOpposingZone: false, minBodyATR: 0.3, strongConfirm: false, riskScale: 0.5
  }
};

// ======================================================
// HELPERS
// ======================================================
function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function getDistance(price, top, bottom) {
  if (price < bottom) return bottom - price;
  if (price > top) return price - top;
  return 0;
}

function toMs(timestamp) {
  let ts = Number(timestamp);
  if (Number.isFinite(ts) && ts > 0 && ts < 1e12) ts *= 1000; // seconds -> ms
  return Number.isFinite(ts) && ts > 0 ? ts : Date.now();
}

function zonedParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat("en-GB", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "numeric", minute: "numeric", hourCycle: "h23"
  });
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), dateKey: `${p.year}-${p.month}-${p.day}` };
}

function addAnnotation(out, type, item, extra = {}) {
  if (!item) return;
  out.push({
    id: `${type}-${item.index ?? item.candleIndex ?? item.confirmIndex ?? item.time ?? out.length}`,
    type,
    time: item.time ?? null,
    index: item.index ?? item.candleIndex ?? item.confirmIndex ?? null,
    price: finite(item.price ?? item.level),
    top: finite(item.top ?? item.high),
    bottom: finite(item.bottom ?? item.low),
    direction: item.direction ?? null,
    label: type.replaceAll("_", " "),
    reason: item.why ?? "",
    ...extra
  });
}

// ======================================================
// CHART ANNOTATIONS
// ======================================================
export function buildChartAnnotations(analysis = {}, decision = null) {
  const annotations = [];

  for (const swing of analysis.swings ?? []) {
    addAnnotation(annotations, "SWING", swing, {
      label: swing.label ? `${swing.label} ${swing.type}` : `Swing ${swing.type}`
    });
  }
  for (const event of analysis.structureEvents ?? []) {
    addAnnotation(annotations, event.type, event, {
      label: `${event.type} ${event.direction}`,
      startTime: event.swingTime,
      startIndex: event.swingIndex
    });
  }
  for (const pool of analysis.liquidityPools ?? []) {
    addAnnotation(annotations, "LIQUIDITY", pool, {
      label: `${pool.kind} ${pool.side}-side liquidity`,
      formedIndex: pool.formedIndex,
      status: pool.status
    });
  }
  for (const sweep of analysis.sweeps ?? []) {
    addAnnotation(annotations, "LIQUIDITY_SWEEP", sweep, {
      label: `${sweep.side}-side liquidity swept`
    });
  }
  for (const ob of analysis.orderBlocks ?? []) {
    addAnnotation(annotations, "ORDER_BLOCK", ob, {
      label: `${ob.direction} order block`,
      startTime: ob.time,
      startIndex: ob.candleIndex,
      endIndex: ob.mitigatedIndex,
      status: ob.status
    });
  }
  for (const fvg of analysis.fvg ?? []) {
    addAnnotation(annotations, "FVG", fvg, {
      label: `${fvg.direction} fair value gap`,
      startTime: fvg.time,
      startIndex: fvg.index,
      endIndex: fvg.mitigatedIndex,
      status: fvg.status
    });
  }

  const range = analysis.dealingRange;
  if (range?.valid) {
    annotations.push({
      id: "DEALING_RANGE", type: "DEALING_RANGE", top: finite(range.high), bottom: finite(range.low), label: "Dealing Range", reason: range.why ?? ""
    });
    annotations.push({
      id: "EQUILIBRIUM", type: "EQUILIBRIUM", price: finite(range.equilibrium), label: "50% Equilibrium"
    });
  }

  const isSignal = decision?.decision === "BUY" || decision?.decision === "SELL";
  if ((isSignal || decision?.watch) && decision?.levels) {
    const levels = decision.levels;
    const entry = finite(levels.entry);
    const sl = finite(levels.stop_loss);
    const targets = levels.take_profit ?? [];
    const tps = [finite(targets[0]), finite(targets[1]), finite(targets[2])];
    const lastTp = [...tps].reverse().find(t => t !== null) ?? null;

    if (entry !== null && sl !== null) {
      annotations.push({
        id: "RISK_ZONE", type: "RISK_ZONE", top: Math.max(entry, sl), bottom: Math.min(entry, sl), label: "RISK ZONE", color: "#ef4444"
      });
      annotations.push({
        id: "ENTRY", type: "ENTRY", price: entry, label: `ENTRY ${entry}`, color: "#ffffff"
      });
      if (lastTp !== null) {
        annotations.push({
          id: "REWARD_ZONE", type: "REWARD_ZONE", top: Math.max(entry, lastTp), bottom: Math.min(entry, lastTp), label: "REWARD ZONE", color: "#22c55e"
        });
      }
      tps.forEach((target, i) => {
        if (target === null) return;
        annotations.push({
          id: `TP${i + 1}`, type: `TP${i + 1}`, price: target, label: `TP${i + 1} ${target}`, color: "#84cc16"
        });
      });
    }
  }
  return annotations;
}

// ======================================================
// SESSION DETECTION (DST-safe: defined in each market's own time zone)
// London Open: 08:00-11:00 London | NY Open: 08:00-11:00 New York
// ======================================================
export function getTradingSession(timestamp = Date.now()) {
  const ms = toMs(timestamp);
  const date = new Date(ms);
  if (!Number.isFinite(date.getTime())) return "UNKNOWN";

  const day = date.getUTCDay();
  if (day === 0 || day === 6) return "WEEKEND";

  const london = zonedParts(ms, "Europe/London").hour;
  const ny = zonedParts(ms, "America/New_York").hour;

  if (london >= 8 && london < 11) return "LONDON_OPEN";
  if (ny >= 8 && ny < 11) return "NY_OPEN";
  if (london >= 11 && london < 16) return "LONDON_MID";
  if (ny >= 11 && ny < 14) return "NY_MID";
  if (london >= 0 && london < 8) return "ASIAN";
  return "OFF_HOURS";
}

// ======================================================
// SEQUENCE CHECK: sweep -> structure break -> order block from that move
// ======================================================
function findSequence(events, sweeps, blocks) {
  for (const sweep of sweeps) {
    for (const event of events) {
      if (event.index < sweep.index) continue;           // BOS/CHoCH must come after the sweep
      const block = blocks.find(b => {
        const ci = finite(b.candleIndex);
        return ci !== null && ci >= sweep.index;         // OB formed at/after the sweep
      });
      if (block) return { sweep, event, block };
    }
  }
  return null;
}

// ======================================================
// STRUCTURAL TARGETS
// ======================================================
function collectObstacles(analysis, trend, entry, options) {
  const dir = trend === "bullish" ? 1 : -1;
  const zones = [];
  const liquidity = [];

  const push = (list, price, label) => {
    const p = finite(price);
    if (p === null) return;
    const distance = (p - entry) * dir;
    if (distance > 0) list.push({ price: p, distance, label });
  };

  for (const ob of analysis.orderBlocks ?? []) {
    if (ob.direction === trend || ob.status !== "unmitigated") continue;
    push(zones, trend === "bullish" ? ob.bottom : ob.top, "Opposing order block");
  }
  for (const lvl of options.htfLevels ?? []) {
    const price = typeof lvl === "object" ? lvl.price : lvl;
    push(zones, price, typeof lvl === "object" && lvl.label ? lvl.label : "HTF level");
  }
  for (const pool of analysis.liquidityPools ?? []) {
    if (pool.status === "swept") continue;
    push(liquidity, pool.price ?? pool.level, "Liquidity pool");
  }
  const byDistance = (a, b) => a.distance - b.distance;
  return { zones: zones.sort(byDistance), liquidity: liquidity.sort(byDistance) };
}

// ======================================================
// CONFIRMATION CANDLE
// ======================================================
function checkConfirmation(trend, candle, prev, atr, profile) {
  const open = finite(candle?.open), close = finite(candle?.close);
  const high = finite(candle?.high), low = finite(candle?.low);
  if (open === null || close === null) return { ok: false, why: "no candle data" };

  const bullish = trend === "bullish";
  if (bullish ? !(close > open) : !(close < open)) return { ok: false, why: "candle is not in trade direction" };

  const body = Math.abs(close - open);
  if (body < atr * profile.minBodyATR) {
    return { ok: false, why: `body ${(body / atr).toFixed(2)} ATR is below ${profile.minBodyATR} ATR` };
  }
  if (!profile.strongConfirm) return { ok: true, why: "directional candle with solid body" };

  const range = high !== null && low !== null ? high - low : 0;
  let rejection = false;
  if (range > 0) {
    const wick = bullish ? Math.min(open, close) - low : high - Math.max(open, close);
    rejection = wick / range >= REJECTION_WICK_RATIO;
  }

  const pH = finite(prev?.high), pL = finite(prev?.low);
  const pO = finite(prev?.open), pC = finite(prev?.close);
  const breaksPrev = bullish ? (pH !== null && close > pH) : (pL !== null && close < pL);
  const engulfs = pO !== null && pC !== null && (bullish
    ? (pC < pO && close >= pO && open <= pC)
    : (pC > pO && close <= pO && open >= pC));

  if (breaksPrev || engulfs || rejection) {
    return { ok: true, why: breaksPrev ? "closed beyond prior candle" : engulfs ? "engulfing candle" : "rejection wick" };
  }
  return { ok: false, why: "no break of prior candle, engulfing, or rejection wick" };
}

// ======================================================
// SIZING + TRADE MANAGEMENT
// ======================================================
function buildSizing(risk, options, riskScale, targetCount) {
  const acct = options.account;
  let sizing = null;
  if (acct && finite(acct.balance) > 0) {
    const riskPercent = (finite(acct.riskPercent) ?? 1) * riskScale;
    const valuePerUnit = finite(acct.valuePerUnit) ?? 1;   // account-currency P/L per 1.0 price move per 1 lot/unit
    const riskAmount = (Number(acct.balance) * riskPercent) / 100;
    let size = riskAmount / (risk * valuePerUnit);
    const step = finite(acct.lotStep);
    if (step && step > 0) size = Math.floor(size / step) * step;
    sizing = { riskPercent, riskAmount, size };
  }
  const splits = { 1: [100], 2: [50, 50], 3: [50, 30, 20] }[Math.min(3, Math.max(1, targetCount))];
  const management = [
    ...splits.map((pct, i) => `Close ${pct}% at TP${i + 1}`),
    "Move stop to break-even once TP1 is hit"
  ];
  return { sizing, management };
}

// ======================================================
// MAIN SETUP EVALUATION ENGINE
// options: { mode, timestamp, htfTrend, htfError, htfLevels, lastCandle,
//            prevCandle, account:{balance,riskPercent,valuePerUnit,lotStep} }
// ======================================================
export function evaluateSetup(analysis, currentPrice, options = {}) {
  const mode = options.mode === "relaxed" ? "relaxed" : "strict";
  const P = PROFILES[mode];
  const price = finite(currentPrice);
  const atr = finite(analysis?.atr?.value);
  const trend = String(analysis?.trend ?? "").toLowerCase();

  const scores = {
    htf: 0, liquidity: 0, structure: 0, fvg_ob: 0,
    supply_demand: 0, premium_discount: 0, session: 0
  };
  const result = {
    decision: "NO_TRADE", direction: null, watch: false, score: 0, maxScore: 100, confidence: 0, quality: null,
    tier: mode.toUpperCase(), breakdown: scores, is_sd: false, confidenceLabel: "Insufficient evidence",
    reasons: [], confluence: [], evidence: [], candidateZone: null, levels: null,
    entryStatus: "NOT_CONFIRMED", session: null, setupKey: null, management: null, sizing: null
  };

  if (price === null || price <= 0 || atr === null || atr <= 0) {
    result.reasons.push("Invalid price or ATR."); return result;
  }
  if (!["bullish", "bearish"].includes(trend)) {
    result.reasons.push(`Market structure is ${trend || "unknown"}.`); return result;
  }

  result.direction = trend === "bullish" ? "BUY" : "SELL";

  const lastIndex = Number(analysis.candlesAnalysed) - 1;
  if (!Number.isFinite(lastIndex) || lastIndex < 0) {
    result.reasons.push("Invalid analysis: candlesAnalysed missing."); return result;
  }

  // 1. SESSION
  const session = getTradingSession(options.timestamp ?? analysis.latestCandleTime ?? Date.now());
  result.session = session;
  const allowed = P.killzonesOnly
    ? ["LONDON_OPEN", "NY_OPEN"]
    : ["LONDON_OPEN", "NY_OPEN", "LONDON_MID", "NY_MID"];
  if (!allowed.includes(session)) {
    result.reasons.push(`Rejected: session ${session} not allowed in ${mode} mode.`);
    return result;
  }
  const isOpen = session === "LONDON_OPEN" || session === "NY_OPEN";
  scores.session = isOpen ? 10 : 5;
  result.confluence.push(session.replaceAll("_", " "));

  // 2. HTF ALIGNMENT (mandatory in both tiers)
  const htfTrend = String(options.htfTrend ?? "").toLowerCase();
  if (!["bullish", "bearish"].includes(htfTrend)) {
    result.reasons.push(`Rejected: higher-timeframe trend unavailable or neutral. ${options.htfError ?? ""}`.trim());
    return result;
  }
  if (htfTrend !== trend) {
    result.reasons.push(`Rejected: trend (${trend}) conflicts with HTF trend (${htfTrend}).`);
    return result;
  }
  scores.htf = 20;
  result.confluence.push(`${trend.toUpperCase()} Trend + HTF aligned`);

  // 3. COLLECT CANDIDATES
  const recentEvents = [...(analysis.structureEvents ?? [])]
    .filter(e => {
      const i = finite(e.index);
      return e.direction === trend && i !== null && lastIndex - i >= 0 && lastIndex - i <= MAX_EVENT_AGE;
    })
    .sort((a, b) => b.index - a.index);
  if (!recentEvents.length) {
    result.reasons.push("Rejected: no recent BOS/CHoCH in the trade direction.");
    return result;
  }

  const recentSweeps = [...(analysis.sweeps ?? [])]
    .filter(s => {
      const i = finite(s.index);
      return s.direction === trend && i !== null && lastIndex - i >= 0 && lastIndex - i <= MAX_SWEEP_AGE;
    })
    .sort((a, b) => b.index - a.index);
  if (!recentSweeps.length && P.requireSweep) {
    result.reasons.push("Rejected: no recent liquidity sweep in the trade direction.");
    return result;
  }

  const validBlocks = (analysis.orderBlocks ?? [])
    .filter(ob => {
      if (ob.direction !== trend || ob.status !== "unmitigated") return false;
      const top = finite(ob.top), bottom = finite(ob.bottom);
      if (top === null || bottom === null || top <= bottom) return false;
      if (trend === "bullish" && price < bottom) return false;
      if (trend === "bearish" && price > top) return false;
      return getDistance(price, top, bottom) <= atr * MAX_ZONE_DISTANCE_ATR;
    })
    .sort((a, b) =>
      getDistance(price, Number(a.top), Number(a.bottom)) - getDistance(price, Number(b.top), Number(b.bottom)));
  if (!validBlocks.length) {
    result.reasons.push("Rejected: no fresh unmitigated order block near price.");
    return result;
  }

  // 4. SEQUENCE: sweep -> BOS/CHoCH -> order block
  let event = recentEvents[0], sweep = recentSweeps[0] ?? null, block = validBlocks[0];
  if (P.requireSequence) {
    const seq = findSequence(recentEvents, recentSweeps, validBlocks);
    if (!seq) {
      result.reasons.push("Rejected: events out of order (need sweep, then BOS/CHoCH, then order block).");
      return result;
    }
    ({ event, sweep, block } = seq);
    result.confluence.push("Sweep > Structure > OB sequence");
  }

  scores.structure = 20;
  result.confluence.push(`${event.type} Confirmed`);
  if (sweep) {
    scores.liquidity = 20;
    result.confluence.push("Liquidity Sweep");
  }

  const blockTop = Number(block.top);
  const blockBottom = Number(block.bottom);
  let obScore = 10;
  result.confluence.push("Order Block");
  result.setupKey = `${options.symbol ?? "?"}:${options.timeframe ?? "?"}:${result.direction}:${block.time ?? block.candleIndex ?? `${blockBottom}-${blockTop}`}`;

  // 5. FVG (bonus)
  const relevantFvg = (analysis.fvg ?? []).find(fvg => {
    if (fvg.direction !== trend) return false;
    if (!["unmitigated", "partially_mitigated"].includes(fvg.status)) return false;
    const top = finite(fvg.top), bottom = finite(fvg.bottom);
    if (top === null || bottom === null) return false;
    return price >= bottom - atr && price <= top + atr;
  });
  if (relevantFvg) { obScore += 5; result.confluence.push("Fair Value Gap"); }
  scores.fvg_ob = obScore;

  // 6. SUPPLY & DEMAND (bonus)
  const validSD = (analysis.swings ?? []).slice(-5).find(sw => {
    const swingPrice = finite(sw.price);
    if (swingPrice === null || !sw.unmitigated) return false;
    if (trend === "bullish" && sw.type === "low") return Math.abs(price - swingPrice) <= atr;
    if (trend === "bearish" && sw.type === "high") return Math.abs(price - swingPrice) <= atr;
    return false;
  });
  if (validSD) {
    scores.supply_demand = 5;
    result.is_sd = true;
    result.confluence.push(trend === "bullish" ? "Demand Zone" : "Supply Zone");
  }

  // 7. PREMIUM / DISCOUNT (mandatory)
  const range = analysis.dealingRange;
  const equilibrium = finite(range?.equilibrium);
  if (!range?.valid || equilibrium === null) {
    result.reasons.push("Rejected: no valid dealing range for premium/discount check.");
    return result;
  }
  if ((trend === "bullish" && price > equilibrium) || (trend === "bearish" && price < equilibrium)) {
    result.reasons.push(`Rejected: price is in the ${trend === "bullish" ? "premium" : "discount"} half of the range.`);
    return result;
  }
  scores.premium_discount = 10;
  result.confluence.push(trend === "bullish" ? "Discount Zone" : "Premium Zone");

  // 8. SCORE
  result.score = Object.values(scores).reduce((t, v) => t + v, 0);
  if (result.score < P.minScore) {
    result.reasons.push(`Score ${result.score}/100 is below the ${mode} minimum of ${P.minScore}.`);
    return result;
  }

  // 9. ENTRY, STOP
  result.candidateZone = { top: blockTop, bottom: blockBottom, orderBlockTime: block.time, status: block.status };
  const insideZone = price >= blockBottom && price <= blockTop;
  const entry = insideZone ? price : (trend === "bullish" ? blockTop : blockBottom);

  const buffer = atr * STOP_BUFFER_ATR;
  const structuralSL = trend === "bullish" ? blockBottom - buffer : blockTop + buffer;
  const minimumDistance = atr * MIN_STOP_ATR;
  const stopLoss = trend === "bullish"
    ? Math.min(structuralSL, entry - minimumDistance)
    : Math.max(structuralSL, entry + minimumDistance);

  const risk = Math.abs(entry - stopLoss);
  if (!Number.isFinite(risk) || risk <= 0) {
    result.reasons.push("Invalid structural stop-loss."); return result;
  }
  if (risk > atr * MAX_STOP_ATR) {
    result.reasons.push(`Rejected: stop is ${(risk / atr).toFixed(1)} ATR, wider than the ${MAX_STOP_ATR} ATR limit.`);
    return result;
  }

  // 10. STRUCTURAL TARGETS
  const dir = trend === "bullish" ? 1 : -1;
  const obstacles = collectObstacles(analysis, trend, entry, options);
  const tp1Distance = risk * TP_R_MULTIPLES[0];

  const nearestZone = obstacles.zones[0];
  if (P.rejectOnOpposingZone && nearestZone && nearestZone.distance < tp1Distance) {
    result.reasons.push(`Rejected: ${nearestZone.label} at ${nearestZone.price} sits between entry and TP1.`);
    return result;
  }

  const nearestAny = [...obstacles.zones, ...obstacles.liquidity].sort((a, b) => a.distance - b.distance)[0];
  const reach = nearestAny ? nearestAny.distance - atr * TARGET_BUFFER_ATR : Infinity;
  if (reach < risk * MIN_TP1_R) {
    result.reasons.push(`Rejected: nearest obstacle (${nearestAny.label}) leaves less than ${MIN_TP1_R}R to TP1.`);
    return result;
  }

  const takeProfit = [];
  for (const r of TP_R_MULTIPLES) {
    const d = Math.min(risk * r, reach);
    const tp = entry + dir * d;
    const prev = takeProfit[takeProfit.length - 1];
    if (prev === undefined || Math.abs(tp - prev) > 1e-9) takeProfit.push(tp);
  }
  if (reach < risk * TP_R_MULTIPLES[2]) {
    result.confluence.push(`TPs capped at ${nearestAny.label}`);
  }

  result.levels = { entry, stop_loss: stopLoss, take_profit: takeProfit, risk };

  const ordered = takeProfit.every((tp, i) =>
    (trend === "bullish" ? tp > (i ? takeProfit[i - 1] : entry) : tp < (i ? takeProfit[i - 1] : entry)));
  const sideOk = trend === "bullish" ? stopLoss < entry : stopLoss > entry;
  if (!ordered || !sideOk) {
    result.reasons.push(`Invalid ${result.direction} price structure.`); return result;
  }

  const plan = buildSizing(risk, options, P.riskScale, takeProfit.length);
  result.sizing = plan.sizing;
  result.management = plan.management;

  // 11. ENTRY CONFIRMATION
  if (!insideZone) {
    result.watch = true;
    result.entryStatus = "WAITING_FOR_RETEST";
    result.confidenceLabel = "Setup forming";
    result.reasons.push("Setup forming: waiting for price to retest the order block.");
    return result;
  }

  const conf = checkConfirmation(trend, options.lastCandle, options.prevCandle, atr, P);
  if (!conf.ok) {
    result.watch = true;
    result.entryStatus = "WAITING_FOR_CONFIRMATION";
    result.confidenceLabel = "Setup forming";
    result.reasons.push(`In the order block, waiting for a stronger confirming candle (${conf.why}).`);
    return result;
  }

  result.entryStatus = "CONFIRMED_ENTRY";
  result.decision = result.direction;
  result.confidence = result.score;
  if (mode === "strict") {
    result.quality = result.score >= 100 ? "HIGH" : "GOOD";
    result.confidenceLabel = result.score >= 100 ? "High Quality Setup" : "Good Setup";
  } else {
    result.quality = "B-GRADE";
    result.confidenceLabel = "Lower-confidence setup (reduced risk)";
  }
  result.reasons.push(`Filters passed (${mode}); entry confirmed: ${conf.why}.`);
  return result;
}

// ======================================================
// SIGNAL LIFECYCLE + DAILY QUOTA TRACKER
// Keep one instance alive across candles. Persist with snapshot()/restore().
// ======================================================
export class SignalTracker {
  constructor(state = {}) {
    this.watches = new Map(Object.entries(state.watches ?? {}));   // key -> first seen (ms)
    this.dead = new Map(Object.entries(state.dead ?? {}));         // key -> time it was expired/invalidated (ms)
    this.fired = new Map(Object.entries(state.fired ?? {}));       // key -> time signal fired (ms)
    this.daily = new Map(Object.entries(state.daily ?? {}));       // dateKey -> count
  }

  snapshot(now = Date.now()) {
    const keep = map => Object.fromEntries([...map].filter(([, t]) => now - Number(t) < 2 * 86400000));
    const days = [...this.daily].slice(-7);   // keep the last 7 days of counts
    return {
      watches: keep(this.watches), dead: keep(this.dead),
      fired: keep(this.fired), daily: Object.fromEntries(days)
    };
  }

  dayKey(ms) { return zonedParts(ms, DAY_TIME_ZONE).dateKey; }

  quota(timestamp) {
    const ms = toMs(timestamp);
    const count = Number(this.daily.get(this.dayKey(ms)) ?? 0);
    const day = new Date(ms).getUTCDay();
    const londonHour = zonedParts(ms, "Europe/London").hour;
    const weekday = day !== 0 && day !== 6;
    return {
      date: this.dayKey(ms), count, target: MIN_DAILY_SIGNALS,
      met: count >= MIN_DAILY_SIGNALS,
      relaxedUnlocked: weekday && count < MIN_DAILY_SIGNALS && londonHour >= RELAX_AFTER_LONDON_HOUR
    };
  }

  // Applies expiry, invalidation and cooldown to an evaluateSetup() result.
  review(result, ctx = {}) {
    const key = result.setupKey;
    if (!key) return result;
    const now = toMs(ctx.timestamp);
    const candleMs = finite(ctx.candleMs) ?? DEFAULT_CANDLE_MS;
    const kill = reason => {
      result.decision = "NO_TRADE"; result.watch = false; result.entryStatus = "NOT_CONFIRMED";
      result.confidenceLabel = "Insufficient evidence"; result.reasons.push(reason); return result;
    };

    // cooldown after a fired signal, or after a dead setup
    const firedAt = Number(this.fired.get(key));
    if (Number.isFinite(firedAt) && now - firedAt < COOLDOWN_CANDLES * candleMs) {
      return kill("Cooldown: this order block already produced a signal.");
    }
    const deadAt = Number(this.dead.get(key));
    if (Number.isFinite(deadAt) && now - deadAt < COOLDOWN_CANDLES * candleMs) {
      return kill("Setup was expired or invalidated earlier; on cooldown.");
    }

    const isSignal = result.decision === "BUY" || result.decision === "SELL";
    if (isSignal) {
      this.fired.set(key, now);
      this.watches.delete(key);
      const dk = this.dayKey(now);
      this.daily.set(dk, Number(this.daily.get(dk) ?? 0) + 1);
      return result;
    }

    if (result.watch) {
      // invalidation: candle closed through the stop before entry
      const close = finite(ctx.lastCandle?.close);
      const sl = finite(result.levels?.stop_loss);
      if (close !== null && sl !== null &&
          (result.direction === "BUY" ? close < sl : close > sl)) {
        this.watches.delete(key); this.dead.set(key, now);
        return kill("Invalidated: price closed through the stop zone before entry.");
      }
      // expiry
      const since = Number(this.watches.get(key));
      if (!Number.isFinite(since)) {
        this.watches.set(key, now);
      } else if (now - since > WATCH_EXPIRY_CANDLES * candleMs) {
        this.watches.delete(key); this.dead.set(key, now);
        return kill(`Expired: no entry within ${WATCH_EXPIRY_CANDLES} candles.`);
      }
    }
    return result;
  }
}

// ======================================================
// TOP-LEVEL ENTRY POINT
// 1) try STRICT. 2) if under the daily target and the relaxed tier is
// unlocked, try RELAXED (B-grade, half risk). Never fabricates signals.
// ======================================================
export function evaluateWithQuota(analysis, currentPrice, options = {}, tracker = new SignalTracker()) {
  const ctx = {
    timestamp: options.timestamp ?? analysis?.latestCandleTime ?? Date.now(),
    candleMs: options.candleMs, lastCandle: options.lastCandle
  };
  const isSignal = r => r.decision === "BUY" || r.decision === "SELL";

  const strict = tracker.review(evaluateSetup(analysis, currentPrice, { ...options, mode: "strict" }), ctx);
  if (isSignal(strict)) { strict.quota = tracker.quota(ctx.timestamp); return strict; }

  const q = tracker.quota(ctx.timestamp);
  if (q.relaxedUnlocked) {
    const relaxed = tracker.review(evaluateSetup(analysis, currentPrice, { ...options, mode: "relaxed" }), ctx);
    if (isSignal(relaxed)) {
      relaxed.reasons.push(`Relaxed tier used to work toward the daily target (${q.count + 1}/${q.target}).`);
      relaxed.quota = tracker.quota(ctx.timestamp);
      return relaxed;
    }
    if (relaxed.watch && !strict.watch) { relaxed.quota = q; return relaxed; }
  }

  strict.quota = q;
  if (!q.met) {
    strict.reasons.push(`Daily quota ${q.count}/${q.target}: no setup met the criteria, so no trade was forced.`);
  }
  return strict;
}


// ######################################################
// PART 2: DATA, ANALYSIS AND ALL-PAIRS SCANNER
// ######################################################
const ENGINE_VERSION = "3.0.0";
const DEFAULT_CANDLE_LIMIT = 300;
const MIN_CLOSED_CANDLES = 30;
const HTF_CANDLE_LIMIT = 200;
const SCAN_CONCURRENCY = 4;          // parallel data fetches
const MAX_CURRENCY_EXPOSURE = 2;     // max same-side trades on one currency (e.g. long USD x2)

const HTF_MAP = { M5: "H1", M15: "H1", M30: "H4", H1: "H4" };
const TF_MS = { M5: 5 * 60e3, M15: 15 * 60e3, M30: 30 * 60e3, H1: 60 * 60e3, H4: 4 * 60 * 60e3 };

// ======================================================
// HELPERS
// ======================================================
function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_k, item) =>
      (typeof item === "number" && !Number.isFinite(item)) ? null : item));
  } catch { return null; }
}

function getClosedCandles(candles) {
  if (!Array.isArray(candles)) return [];
  return candles
    .filter(c => c && c.closed === true)
    .filter(c => ["time", "open", "high", "low", "close"].every(k => Number.isFinite(Number(c[k]))))
    .filter(c => {
      const o = Number(c.open), h = Number(c.high), l = Number(c.low), cl = Number(c.close);
      return h >= Math.max(o, cl, l) && l <= Math.min(o, cl, h) && l > 0;
    })
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function summarizeCandle(c) {
  if (!c) return null;
  return {
    time: Math.floor(Number(c.time) / 1000),
    iso: c.iso || new Date(Number(c.time)).toISOString(),
    open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
    volume: Number(c.tickVolume ?? c.volume ?? 0)
  };
}

const ohlc = c => c ? ({ open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close) }) : null;

function getQuality(market, closed) {
  const s = market.quality || {};
  return {
    received: Number(s.received ?? market.candles?.length ?? 0),
    accepted: Number(s.accepted ?? closed.length),
    closedAccepted: closed.length,
    rejectedCount: Number(s.rejectedCount ?? 0),
    rejected: jsonSafe(s.rejected ?? []),
    duplicatesRemoved: Number(s.duplicatesRemoved ?? 0),
    gaps: jsonSafe(s.gaps ?? []),
    unexpectedGaps: jsonSafe(s.unexpectedGaps ?? []),
    warnings: jsonSafe(s.warnings ?? [])
  };
}

function buildErrorResult({ symbol, timeframe, message, startedAt, extra = {} }) {
  return {
    ok: false, engineVersion: ENGINE_VERSION, status: "DATA_ERROR", symbol, timeframe,
    error: message, processingMs: Date.now() - startedAt, ...extra
  };
}

async function mapPool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// Currency exposure: BUY EURUSD = +EUR, -USD
function exposureDelta(symbol, direction) {
  const base = symbol.slice(0, 3), quote = symbol.slice(3, 6);
  const s = direction === "BUY" ? 1 : -1;
  return { [base]: s, [quote]: -s };
}
function exposureBlocked(exposure, symbol, direction) {
  const delta = exposureDelta(symbol, direction);
  for (const [ccy, d] of Object.entries(delta)) {
    if (Math.abs((exposure[ccy] ?? 0) + d) > MAX_CURRENCY_EXPOSURE) return ccy;
  }
  return null;
}
function addExposure(exposure, symbol, direction) {
  for (const [ccy, d] of Object.entries(exposureDelta(symbol, direction))) {
    exposure[ccy] = (exposure[ccy] ?? 0) + d;
  }
}

// ======================================================
// HTF TREND (cached per scan so M5 and M15 share one H1 fetch)
// ======================================================
async function loadHtfTrend(env, symbolKey, tfKey, cache) {
  const htfKey = HTF_MAP[tfKey] ?? null;
  if (!htfKey || !TIMEFRAMES[htfKey]) {
    return { timeframe: htfKey, trend: null, error: `No usable higher timeframe for ${tfKey}.` };
  }
  const cacheKey = `${symbolKey}:${htfKey}`;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);

  const job = (async () => {
    try {
      const m = await getMarketData(env, symbolKey, htfKey, HTF_CANDLE_LIMIT);
      if (!m || m.ok !== true) return { timeframe: htfKey, trend: null, error: m?.error || `${htfKey} data unavailable.` };
      const closed = getClosedCandles(m.candles);
      if (closed.length < MIN_CLOSED_CANDLES) return { timeframe: htfKey, trend: null, error: `Not enough ${htfKey} candles.` };
      const a = analyze(closed, htfKey);
      if (!a || a.ok !== true) return { timeframe: htfKey, trend: null, error: `${htfKey} analysis failed.` };
      return { timeframe: htfKey, trend: String(a.trend ?? "").toLowerCase() || null, error: null };
    } catch (e) {
      return { timeframe: htfKey, trend: null, error: e?.message || `${htfKey} fetch failed.` };
    }
  })();
  cache?.set(cacheKey, job);
  return job;
}

// ======================================================
// STEP 1: PREPARE (fetch + analyse; no decision yet)
// ======================================================
async function prepare(env, symbolKey, tfKey, options = {}) {
  const startedAt = Date.now();
  const fail = (message, extra) => ({ ok: false, result: buildErrorResult({ symbol: symbolKey, timeframe: tfKey, message, startedAt, extra }) });

  if (!SYMBOLS[symbolKey]) return fail(`Unsupported symbol: ${symbolKey}`);
  if (!TIMEFRAMES[tfKey]) return fail(`Unsupported timeframe: ${tfKey}`);

  const req = Number(options.limit);
  const limit = Number.isInteger(req) ? Math.max(50, Math.min(req, 500)) : DEFAULT_CANDLE_LIMIT;

  try {
    const market = await getMarketData(env, symbolKey, tfKey, limit);
    if (!market || market.ok !== true) {
      return fail(market?.error || "Market data provider returned no valid data.", { provider: market?.provider ?? "unknown" });
    }

    const closedCandles = getClosedCandles(market.candles);
    const quality = getQuality(market, closedCandles);
    const freshness = assessFreshness(closedCandles, tfKey, Date.now());
    const chartCandles = closedCandles.map(summarizeCandle);

    const marketSummary = {
      provider: market.provider ?? "unknown", symbol: symbolKey, timeframe: tfKey,
      interval: market.interval ?? TIMEFRAMES[tfKey].interval,
      fetchedAt: market.fetchedAt ?? new Date().toISOString(),
      cached: Boolean(market.cached),
      candleCount: Array.isArray(market.candles) ? market.candles.length : 0,
      closedCandleCount: closedCandles.length,
      latestClosedCandle: chartCandles.at(-1) ?? null,
      currentPrice: chartCandles.at(-1)?.close ?? null,
      candles: chartCandles, quality, freshness
    };

    if (closedCandles.length < MIN_CLOSED_CANDLES) {
      return {
        ok: false,
        result: {
          ok: false, engineVersion: ENGINE_VERSION, status: "INSUFFICIENT_DATA",
          symbol: symbolKey, symbolName: SYMBOLS[symbolKey].name, timeframe: tfKey, market: marketSummary,
          signal: {
            decision: "NO_TRADE", direction: null, watch: false, score: 0, maxScore: null,
            confidenceLabel: "INSUFFICIENT_DATA",
            reasons: [`Only ${closedCandles.length} valid closed candles are available.`, `At least ${MIN_CLOSED_CANDLES} are required.`],
            evidence: [], candidateZone: null, levels: null, entryStatus: "NOT_EVALUATED"
          },
          analysis: null, annotations: [], processingMs: Date.now() - startedAt
        }
      };
    }

    const analysis = analyze(closedCandles, tfKey);
    if (!analysis || analysis.ok !== true) {
      return fail(analysis?.error || "SMC analysis failed.", { market: marketSummary, analysis: jsonSafe(analysis) });
    }

    const ltfTrend = String(analysis.trend ?? "").toLowerCase();
    let htf = { timeframe: null, trend: null, error: null };
    if (options.htfTrend) {
      htf = { timeframe: "manual", trend: String(options.htfTrend).toLowerCase(), error: null };
    } else if (ltfTrend === "bullish" || ltfTrend === "bearish") {
      htf = await loadHtfTrend(env, symbolKey, tfKey, options.htfCache);
    }

    return { ok: true, ctx: { symbolKey, tfKey, startedAt, market, marketSummary, closedCandles, chartCandles, analysis, htf } };
  } catch (error) {
    console.error("SKY AI PREPARE ERROR", { symbol: symbolKey, timeframe: tfKey, message: error?.message });
    return fail(error?.message || "Unexpected signal engine error.");
  }
}

// ======================================================
// STEP 2: DECIDE (pure + fast; can run strict then relaxed on the same data)
// opts: { mode, tracker, activeSymbols, exposure, htfLevels, account, timestamp }
// ======================================================
function decide(ctx, opts = {}) {
  const { symbolKey, tfKey, startedAt, market, marketSummary, closedCandles, chartCandles, analysis, htf } = ctx;
  const mode = opts.mode === "relaxed" ? "relaxed" : "strict";
  const tracker = opts.tracker ?? new SignalTracker();

  // one trade per pair
  if (opts.activeSymbols?.includes(symbolKey)) {
    return {
      ok: false, engineVersion: ENGINE_VERSION, status: "SKIPPED", symbol: symbolKey, timeframe: tfKey,
      signal: { decision: "NO_TRADE", direction: null, score: 0,
        reasons: [`${symbolKey} already has an active trade. Skipping to prevent overlap.`] }
    };
  }

  const currentPrice = chartCandles.at(-1).close;
  const lastClosed = closedCandles.at(-1);
  const prevClosed = closedCandles.at(-2);
  const candleMs = TF_MS[tfKey];
  const timestamp = opts.timestamp ?? Number(lastClosed.time);
  const lastCandle = ohlc(lastClosed);

  let setup = evaluateSetup(analysis, currentPrice, {
    mode, symbol: symbolKey, timeframe: tfKey,
    htfTrend: htf.trend, htfError: htf.error, htfLevels: opts.htfLevels,
    account: opts.account, lastCandle, prevCandle: ohlc(prevClosed), candleMs, timestamp
  });
  if (!setup || typeof setup !== "object") {
    return buildErrorResult({ symbol: symbolKey, timeframe: tfKey, message: "Setup evaluator returned no valid result.", startedAt });
  }

  // currency exposure cap (runs before the tracker counts the signal)
  if ((setup.decision === "BUY" || setup.decision === "SELL") && opts.exposure) {
    const ccy = exposureBlocked(opts.exposure, symbolKey, setup.decision);
    if (ccy) {
      setup.decision = "NO_TRADE"; setup.watch = false; setup.entryStatus = "NOT_CONFIRMED";
      setup.confidenceLabel = "Insufficient evidence";
      setup.reasons.push(`Blocked: already at max ${MAX_CURRENCY_EXPOSURE} same-side trades on ${ccy}.`);
    }
  }

  setup = tracker.review(setup, { timestamp, candleMs, lastCandle });

  const annotations = buildChartAnnotations(analysis, setup);
  const decision = setup.decision ?? "NO_TRADE";

  return {
    ok: true, engineVersion: ENGINE_VERSION,
    status: decision === "NO_TRADE" ? (setup.watch ? "SETUP_FORMING" : "NO_TRADE") : "SETUP_FOUND",
    tier: setup.tier ?? mode.toUpperCase(),
    symbol: symbolKey, symbolName: SYMBOLS[symbolKey].name, timeframe: tfKey,
    provider: market.provider ?? "unknown", fetchedAt: market.fetchedAt ?? null, cached: Boolean(market.cached),
    processingMs: Date.now() - startedAt,
    htf: { timeframe: htf.timeframe, trend: htf.trend },
    market: marketSummary,
    analysis: jsonSafe(analysis),
    setup: jsonSafe(setup),
    annotations: Array.isArray(annotations) ? jsonSafe(annotations) : [],
    signal: {
      decision, direction: setup.direction ?? null, watch: Boolean(setup.watch),
      tier: setup.tier ?? null, quality: setup.quality ?? null,
      score: setup.score ?? null, maxScore: setup.maxScore ?? null,
      confidenceLabel: setup.confidenceLabel ?? null, session: setup.session ?? null,
      reasons: jsonSafe(setup.reasons ?? []), evidence: jsonSafe(setup.evidence ?? []),
      candidateZone: jsonSafe(setup.candidateZone ?? null), levels: jsonSafe(setup.levels ?? null),
      sizing: jsonSafe(setup.sizing ?? null), management: jsonSafe(setup.management ?? null),
      entryStatus: setup.entryStatus ?? null
    }
  };
}

// ======================================================
// SINGLE SYMBOL (same API as before)
// ======================================================
export async function getSignal(env, symbolKey = "XAUUSD", tfKey = "M15", options = {}) {
  const prep = await prepare(env, symbolKey, tfKey, options);
  if (!prep.ok) return prep.result;
  try {
    return decide(prep.ctx, options);
  } catch (error) {
    console.error("SKY AI DECIDE ERROR", { symbol: symbolKey, timeframe: tfKey, message: error?.message, stack: error?.stack });
    return buildErrorResult({ symbol: symbolKey, timeframe: tfKey, message: error?.message || "Unexpected signal engine error.", startedAt: prep.ctx.startedAt });
  }
}

export async function runSignalEngine(env, symbolKey = "XAUUSD", tfKey = "M15") {
  return JSON.stringify(await getSignal(env, symbolKey, tfKey));
}

// ======================================================
// TRACKER STATE (optional KV binding named SKY_STATE; otherwise in-memory)
// ======================================================
async function loadTracker(env) {
  try {
    const saved = await env?.SKY_STATE?.get("tracker", "json");
    return new SignalTracker(saved ?? {});
  } catch { return new SignalTracker(); }
}
async function saveTracker(env, tracker) {
  try { await env?.SKY_STATE?.put("tracker", JSON.stringify(tracker.snapshot())); } catch { /* ignore */ }
}

// ======================================================
// SCAN ALL PAIRS
// options: { symbols, timeframes, tracker, activeSymbols, concurrency, account, htfLevels, timestamp }
// Pass 1: strict rules on every pair/timeframe.
// Pass 2: only if under the daily target and the relaxed tier is unlocked,
//         try relaxed (B-grade) on the leftovers, best candidates first.
// ======================================================
export async function scanAll(env, options = {}) {
  const startedAt = Date.now();
  const symbols = options.symbols ?? Object.keys(SYMBOLS);
  const timeframes = options.timeframes ?? ["M15", "M5"];   // higher timeframe first: it wins the pair lock
  const tracker = options.tracker ?? await loadTracker(env);
  const activeSymbols = [...(options.activeSymbols ?? [])];
  const exposure = {};
  const htfCache = new Map();
  const nowTs = options.timestamp ?? Date.now();

  // fetch + analyse everything in parallel (limited)
  const jobs = symbols.flatMap(s => timeframes.map(tf => ({ s, tf })));
  const prepared = await mapPool(jobs, options.concurrency ?? SCAN_CONCURRENCY,
    ({ s, tf }) => prepare(env, s, tf, { ...options, htfCache }));

  const errors = [];
  const evaluated = [];   // { ctx, result }
  const signals = [];
  const base = { tracker, activeSymbols, exposure, account: options.account, htfLevels: options.htfLevels, timestamp: options.timestamp };

  const accept = result => {
    signals.push(result);
    activeSymbols.push(result.symbol);
    addExposure(exposure, result.symbol, result.signal.decision);
  };

  // PASS 1: strict
  for (const p of prepared) {
    if (!p.ok) { errors.push({ symbol: p.result.symbol, timeframe: p.result.timeframe, status: p.result.status, error: p.result.error ?? p.result.signal?.reasons?.[0] }); continue; }
    const result = decide(p.ctx, { ...base, mode: "strict" });
    evaluated.push({ ctx: p.ctx, result });
    if (result.status === "SETUP_FOUND") accept(result);
  }

  // PASS 2: relaxed top-up toward the daily target
  const q0 = tracker.quota(nowTs);
  if (q0.relaxedUnlocked) {
    const leftovers = evaluated
      .filter(e => e.result.status === "SETUP_FORMING" || e.result.status === "NO_TRADE")
      .sort((a, b) => (b.result.status === "SETUP_FORMING") - (a.result.status === "SETUP_FORMING")
        || (b.result.signal?.score ?? 0) - (a.result.signal?.score ?? 0));
    for (const e of leftovers) {
      if (tracker.quota(nowTs).met) break;
      if (activeSymbols.includes(e.ctx.symbolKey)) continue;
      const r = decide(e.ctx, { ...base, mode: "relaxed" });
      if (r.status === "SETUP_FOUND") accept(r);
    }
  }

  // summary: which gate rejects most (use this to tune constants)
  const rejections = {};
  for (const e of evaluated) {
    if (e.result.status !== "NO_TRADE") continue;
    const why = String(e.result.signal?.reasons?.at(-1) ?? "unknown").replace(/[\d.]+/g, "#");
    rejections[why] = (rejections[why] ?? 0) + 1;
  }

  await saveTracker(env, tracker);

  const forming = evaluated
    .filter(e => e.result.status === "SETUP_FORMING")
    .map(e => ({ symbol: e.result.symbol, timeframe: e.result.timeframe, direction: e.result.signal.direction,
      entryStatus: e.result.signal.entryStatus, score: e.result.signal.score, levels: e.result.signal.levels }));

  return {
    ok: true,
    engineVersion: ENGINE_VERSION,
    scanned: { symbols: symbols.length, timeframes, combos: jobs.length },
    quota: tracker.quota(nowTs),
    signals: signals.sort((a, b) => (b.signal.score ?? 0) - (a.signal.score ?? 0)),
    forming,
    rejections,
    errors,
    processingMs: Date.now() - startedAt
  };
}

export async function runScanner(env, options = {}) {
  return JSON.stringify(jsonSafe(await scanAll(env, options)));
}
