// ======================================================
// SKY AI SIGNALS - decision engine v2.2 (HIGH-PRECISION MODE)
// Fewer signals, stricter gates. Tune the constants below.
// ======================================================
const MAX_ZONE_DISTANCE_ATR = 1.0;   // price must be within 1 ATR of the order block
const MAX_EVENT_AGE = 30;            // BOS/CHoCH must be within last 30 candles
const MAX_SWEEP_AGE = 25;            // liquidity sweep must be within last 25 candles
const MIN_SIGNAL_SCORE = 95;         // baseline of mandatory gates = 90, so FVG or S&D is also needed
const MIN_STOP_ATR = 1.5;
const MAX_STOP_ATR = 3.0;            // reject setups with a huge stop
const STOP_BUFFER_ATR = 0.2;
const TP_R_MULTIPLES = [1, 2, 3];    // TP1 / TP2 / TP3 in R. Use [2, 3, 4] for the old 1:2 / 1:3 / 1:4

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

  // Draw the trade box for confirmed signals and for "watch" setups (waiting for retest/confirmation)
  const isSignal = decision?.decision === "BUY" || decision?.decision === "SELL";
  if ((isSignal || decision?.watch) && decision?.levels) {
    const levels = decision.levels;
    const entry = finite(levels.entry);
    const sl = finite(levels.stop_loss);
    const targets = levels.take_profit ?? [];
    const tp1 = finite(targets[0]); const tp2 = finite(targets[1]); const tp3 = finite(targets[2]);

    if (entry !== null && sl !== null) {
      annotations.push({
        id: "RISK_ZONE", type: "RISK_ZONE", top: Math.max(entry, sl), bottom: Math.min(entry, sl), label: "RISK ZONE", color: "#ef4444"
      });
      annotations.push({
        id: "ENTRY", type: "ENTRY", price: entry, label: `ENTRY ${entry}`, color: "#ffffff"
      });
      if (tp3 !== null) {
        annotations.push({
          id: "REWARD_ZONE", type: "REWARD_ZONE", top: Math.max(entry, tp3), bottom: Math.min(entry, tp3), label: "REWARD ZONE", color: "#22c55e"
        });
      }
      [tp1, tp2, tp3].forEach((target, i) => {
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
// SESSION DETECTION
// ======================================================
function getTradingSession(timestamp = Date.now()) {
  let ts = Number(timestamp);
  if (Number.isFinite(ts) && ts > 0 && ts < 1e12) ts *= 1000; // seconds -> ms
  const date = new Date(ts);
  if (!Number.isFinite(date.getTime())) return "UNKNOWN";

  const day = date.getUTCDay();
  if (day === 0 || day === 6) return "WEEKEND";

  // EAT = UTC+3
  const hour = (date.getUTCHours() + 3) % 24;

  if (hour >= 2 && hour < 10) return "ASIAN";
  if (hour >= 10 && hour < 13) return "LONDON_OPEN";
  if (hour >= 13 && hour < 16) return "LONDON_MID";
  if (hour >= 16 && hour < 19) return "NY_OPEN";
  return "OFF_HOURS";
}

// ======================================================
// MAIN SETUP EVALUATION ENGINE (HIGH-PRECISION MODE)
// ======================================================
export function evaluateSetup(analysis, currentPrice, options = {}) {
  const price = finite(currentPrice);
  const atr = finite(analysis?.atr?.value);
  const trend = String(analysis?.trend ?? "").toLowerCase();

  const scores = {
    htf: 0, liquidity: 0, structure: 0, fvg_ob: 0,
    supply_demand: 0, premium_discount: 0, session: 0
  };
  const result = {
    decision: "NO_TRADE", direction: null, watch: false, score: 0, maxScore: 100, confidence: 0, quality: null,
    breakdown: scores, is_sd: false, confidenceLabel: "Insufficient evidence", reasons: [], confluence: [],
    evidence: [], candidateZone: null, levels: null, entryStatus: "NOT_CONFIRMED", session: null
  };

  if (price === null || price <= 0 || atr === null || atr <= 0) {
    result.reasons.push("Invalid price or ATR."); return result;
  }
  if (!["bullish", "bearish"].includes(trend)) {
    result.reasons.push(`Market structure is ${trend || "unknown"}.`); return result;
  }

  result.direction = trend === "bullish" ? "BUY" : "SELL";
  const lastIndex = Number(analysis.candlesAnalysed) - 1;

  // 1. SESSION FILTER (killzones only, no weekends)
  const sessionTimestamp = options.timestamp ?? analysis.latestCandleTime ?? Date.now();
  const session = getTradingSession(sessionTimestamp);
  result.session = session;
  if (session !== "LONDON_OPEN" && session !== "NY_OPEN") {
    result.reasons.push(`Rejected: outside prime killzones. Current session: ${session}.`);
    return result;
  }
  scores.session = 10;
  result.confluence.push(session === "LONDON_OPEN" ? "London Open" : "NY Open");

  // 2. HTF ALIGNMENT (MANDATORY - no HTF data means no trade)
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

  // 3. MARKET STRUCTURE (MANDATORY)
  const recentEvent = [...(analysis.structureEvents ?? [])]
    .filter(event => {
      const index = finite(event.index);
      return event.direction === trend && index !== null && lastIndex - index >= 0 && lastIndex - index <= MAX_EVENT_AGE;
    })
    .sort((a, b) => b.index - a.index)[0];

  if (!recentEvent) {
    result.reasons.push("Rejected: no recent BOS/CHoCH in the trade direction.");
    return result;
  }
  scores.structure = 20;
  result.confluence.push(`${recentEvent.type} Confirmed`);

  // 4. LIQUIDITY SWEEP (MANDATORY)
  const relevantSweep = [...(analysis.sweeps ?? [])]
    .filter(sweep => {
      const index = finite(sweep.index);
      return sweep.direction === trend && index !== null && lastIndex - index >= 0 && lastIndex - index <= MAX_SWEEP_AGE;
    })
    .sort((a, b) => b.index - a.index)[0];

  if (!relevantSweep) {
    result.reasons.push("Rejected: no recent liquidity sweep in the trade direction.");
    return result;
  }
  scores.liquidity = 20;
  result.confluence.push("Liquidity Sweep");

  // 5. ORDER BLOCK (MANDATORY, fresh/unmitigated only, price must not be through it)
  const validBlocks = (analysis.orderBlocks ?? [])
    .filter(ob => {
      if (ob.direction !== trend) return false;
      if (ob.status !== "unmitigated") return false;
      const top = finite(ob.top), bottom = finite(ob.bottom);
      if (top === null || bottom === null || top <= bottom) return false;
      if (trend === "bullish" && price < bottom) return false; // already broken
      if (trend === "bearish" && price > top) return false;    // already broken
      return getDistance(price, top, bottom) <= atr * MAX_ZONE_DISTANCE_ATR;
    })
    .sort((a, b) => getDistance(price, a.top, a.bottom) - getDistance(price, b.top, b.bottom));

  const block = validBlocks[0];
  if (!block) {
    result.reasons.push("Rejected: no fresh unmitigated order block near price.");
    return result;
  }
  const blockTop = Number(block.top);
  const blockBottom = Number(block.bottom);
  let obScore = 10;
  result.confluence.push("Order Block");

  // 6. FAIR VALUE GAP (bonus)
  const relevantFvg = (analysis.fvg ?? []).find(fvg => {
    if (fvg.direction !== trend) return false;
    if (!["unmitigated", "partially_mitigated"].includes(fvg.status)) return false;
    const top = finite(fvg.top), bottom = finite(fvg.bottom);
    if (top === null || bottom === null) return false;
    return price >= bottom - atr && price <= top + atr;
  });
  if (relevantFvg) {
    obScore += 5;
    result.confluence.push("Fair Value Gap");
  }
  scores.fvg_ob = obScore;

  // 7. SUPPLY & DEMAND (bonus)
  const recentSwings = (analysis.swings ?? []).slice(-5);
  const validSD = recentSwings.find(sw => {
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

  // 8. PREMIUM / DISCOUNT (MANDATORY): buy only in discount, sell only in premium
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

  // 9. SCORE
  result.score = Object.values(scores).reduce((total, value) => total + value, 0);
  if (result.score < MIN_SIGNAL_SCORE) {
    result.reasons.push(`Score ${result.score}/100 is below minimum ${MIN_SIGNAL_SCORE} (needs a Fair Value Gap or Supply/Demand zone too).`);
    return result;
  }

  // 10. ENTRY, STOP, TARGETS
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

  const multiplier = trend === "bullish" ? 1 : -1;
  const [tp1, tp2, tp3] = TP_R_MULTIPLES.map(r => entry + multiplier * risk * r);
  result.levels = { entry, stop_loss: stopLoss, take_profit: [tp1, tp2, tp3], risk };

  if (trend === "bullish") {
    if (!(stopLoss < entry && entry < tp1 && tp1 < tp2 && tp2 < tp3)) {
      result.reasons.push("Invalid BUY price structure."); return result;
    }
  } else {
    if (!(stopLoss > entry && entry > tp1 && tp1 > tp2 && tp2 > tp3)) {
      result.reasons.push("Invalid SELL price structure."); return result;
    }
  }

  // 11. ENTRY CONFIRMATION: wait for the retest, then a confirming candle
  if (!insideZone) {
    result.watch = true;
    result.entryStatus = "WAITING_FOR_RETEST";
    result.confidenceLabel = "Setup forming";
    result.reasons.push("Setup forming: waiting for price to retest the order block.");
    return result;
  }

  const candle = options.lastCandle;
  const open = finite(candle?.open), close = finite(candle?.close);
  const confirmed = open !== null && close !== null &&
    (trend === "bullish" ? close > open : close < open);

  if (!confirmed) {
    result.watch = true;
    result.entryStatus = "WAITING_FOR_CONFIRMATION";
    result.confidenceLabel = "Setup forming";
    result.reasons.push("Price is in the order block: waiting for a confirming candle close.");
    return result;
  }

  result.entryStatus = "CONFIRMED_ENTRY";
  result.decision = result.direction;
  result.confidence = result.score;
  result.quality = result.score >= 100 ? "HIGH" : "GOOD";
  result.confidenceLabel = result.score >= 100 ? "High Quality Setup" : "Good Setup";
  result.reasons.push("All mandatory filters passed and entry candle confirmed.");

  return result;
}
