
const MAX_ZONE_DISTANCE_ATR = 2.5;
const MAX_EVENT_AGE = 40;
const MIN_SIGNAL_SCORE = 65;
const MIN_STOP_ATR = 1.5;
const STOP_BUFFER_ATR = 0.2;

function finite(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
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
// Green = profit zone
// Red = risk zone
// ======================================================

export function buildChartAnnotations(analysis = {}, decision = null) {
  const annotations = [];

  for (const swing of analysis.swings ?? []) {
    addAnnotation(annotations, "SWING", swing, {
      label: swing.label
        ? `${swing.label} ${swing.type}`
        : `Swing ${swing.type}`
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

  // Dealing range
  const range = analysis.dealingRange;

  if (range?.valid) {
    annotations.push({
      id: "DEALING_RANGE",
      type: "DEALING_RANGE",
      top: finite(range.high),
      bottom: finite(range.low),
      label: "Dealing Range",
      reason: range.why ?? ""
    });

    annotations.push({
      id: "EQUILIBRIUM",
      type: "EQUILIBRIUM",
      price: finite(range.equilibrium),
      label: "50% Equilibrium"
    });
  }

  // Trade annotations only for approved signals
  if (
    decision?.decision === "BUY" ||
    decision?.decision === "SELL"
  ) {
    const levels = decision.levels;

    if (levels) {
      const entry = finite(levels.entry);
      const sl = finite(levels.stop_loss);
      const targets = levels.take_profit ?? [];

      const tp1 = finite(targets[0]);
      const tp2 = finite(targets[1]);
      const tp3 = finite(targets[2]);

      const endIndex = Math.max(
        0,
        (analysis.candlesAnalysed ?? 1) - 1
      );

      const startIndex = Math.max(
        0,
        decision.chartStartIndex ?? 0
      );

      if (entry !== null && sl !== null) {

        // RED STOP-LOSS ZONE
        annotations.push({
          id: "RISK_ZONE",
          type: "RISK_ZONE",
          top: Math.max(entry, sl),
          bottom: Math.min(entry, sl),
          startIndex,
          endIndex,
          label: "STOP LOSS / RISK ZONE",
          color: "#ef4444",
          direction: decision.direction
        });

        // ENTRY LINE
        annotations.push({
          id: "ENTRY",
          type: "ENTRY",
          price: entry,
          label: `ENTRY ${entry}`,
          direction: decision.direction,
          color: "#ffffff"
        });

        // STOP LOSS LINE
        annotations.push({
          id: "STOP_LOSS",
          type: "STOP_LOSS",
          price: sl,
          label: `STOP LOSS ${sl}`,
          color: "#ef4444",
          direction: decision.direction
        });

        // GREEN PROFIT ZONE
        if (tp3 !== null) {
          annotations.push({
            id: "REWARD_ZONE",
            type: "REWARD_ZONE",
            top: Math.max(entry, tp3),
            bottom: Math.min(entry, tp3),
            startIndex,
            endIndex,
            label: "TAKE PROFIT / REWARD ZONE",
            color: "#22c55e",
            direction: decision.direction
          });
        }

        // TAKE PROFIT LEVELS
        [tp1, tp2, tp3].forEach((target, i) => {
          if (target === null) return;

          annotations.push({
            id: `TP${i + 1}`,
            type: `TP${i + 1}`,
            price: target,
            label: `TP${i + 1} ${target}`,
            color: "#84cc16",
            direction: decision.direction
          });
        });

        // Risk / Reward information
        const risk = Math.abs(entry - sl);
        const reward = tp3 !== null
          ? Math.abs(tp3 - entry)
          : 0;

        annotations.push({
          id: "RISK_REWARD",
          type: "RISK_REWARD",
          price: entry,
          risk,
          reward,
          ratio: risk > 0 ? reward / risk : null,
          label: risk > 0
            ? `RISK / REWARD 1:${(reward / risk).toFixed(2)}`
            : "INVALID RISK / REWARD"
        });
      }
    }
  }

  return annotations;
}

// ======================================================
// SESSION DETECTION - EAST AFRICAN TIME
// ======================================================

function getTradingSession(timestamp = Date.now()) {
  const date = new Date(timestamp);

  if (!Number.isFinite(date.getTime())) {
    return "UNKNOWN";
  }

  // EAT = UTC+3
  const hour = (date.getUTCHours() + 3) % 24;

  if (hour >= 2 && hour < 10) return "ASIAN";
  if (hour >= 10 && hour < 15) return "LONDON";
  if (hour >= 15 && hour < 16) return "TRANSITION";
  if (hour >= 16 && hour < 20) return "NEW_YORK";

  return "OFF_HOURS";
}

// ======================================================
// MAIN SETUP EVALUATION ENGINE
// ======================================================

export function evaluateSetup(
  analysis,
  currentPrice,
  options = {}
) {
  const price = finite(currentPrice);
  const atr = finite(analysis?.atr?.value);

  const trend = String(
    analysis?.trend ?? ""
  ).toLowerCase();

  const scores = {
    htf: 0,
    liquidity: 0,
    structure: 0,
    fvg_ob: 0,
    supply_demand: 0,
    session: 0
  };

  const result = {
    decision: "NO_TRADE",
    direction: null,
    score: 0,
    maxScore: 100,
    confidence: 0,
    quality: null,
    breakdown: scores,
    is_sd: false,
    confidenceLabel: "Insufficient evidence",
    reasons: [],
    confluence: [],
    evidence: [],
    candidateZone: null,
    levels: null,
    entryStatus: "NOT_CONFIRMED",
    session: null
  };

  // --------------------------------------------------
  // 1. VALIDATION
  // --------------------------------------------------

  if (
    price === null ||
    price <= 0 ||
    atr === null ||
    atr <= 0
  ) {
    result.reasons.push("Invalid price or ATR.");
    return result;
  }

  if (!["bullish", "bearish"].includes(trend)) {
    result.reasons.push(
      `Market structure is ${trend || "unknown"}.`
    );
    return result;
  }

  result.direction = trend === "bullish" ? "BUY" : "SELL";

  const lastIndex = Number(analysis.candlesAnalysed) - 1;

  if (!Number.isFinite(lastIndex) || lastIndex < 0) {
    result.reasons.push("Invalid candle history.");
    return result;
  }

  // --------------------------------------------------
  // 2. HIGHER TIMEFRAME BIAS
  // --------------------------------------------------

  // This score assumes analysis.trend is a validated HTF bias.
  // Pass a genuinely calculated higher-timeframe trend here.

  if (
    options.htfTrend &&
    String(options.htfTrend).toLowerCase() !== trend
  ) {
    result.reasons.push("Higher timeframe conflicts with setup.");
    return result;
  }

  scores.htf = 20;
  result.confluence.push(
    `${trend.toUpperCase()} Trend`
  );

  // --------------------------------------------------
  // 3. MARKET STRUCTURE
  // --------------------------------------------------

  const recentEvent = [...(analysis.structureEvents ?? [])]
    .filter(event => {
      const index = finite(event.index);

      return (
        event.direction === trend &&
        index !== null &&
        lastIndex - index >= 0 &&
        lastIndex - index <= MAX_EVENT_AGE
      );
    })
    .sort((a, b) => b.index - a.index)[0];

  if (recentEvent) {
    scores.structure = 20;

    result.confluence.push(
      `${recentEvent.type} Confirmed`
    );

    result.evidence.push({
      type: "STRUCTURE",
      event: recentEvent.type,
      index: recentEvent.index
    });
  }

  // --------------------------------------------------
  // 4. ORDER BLOCK ANALYSIS
  // --------------------------------------------------

  const validBlocks = (analysis.orderBlocks ?? [])
    .filter(ob => {
      if (ob.direction !== trend) return false;

      if (
        !["unmitigated", "mitigated"].includes(ob.status)
      ) return false;

      const top = finite(ob.top);
      const bottom = finite(ob.bottom);

      if (
        top === null ||
        bottom === null ||
        top <= bottom
      ) return false;

      return (
        getDistance(price, top, bottom) <=
        atr * MAX_ZONE_DISTANCE_ATR
      );
    })
    .sort((a, b) => {
      return (
        getDistance(price, a.top, a.bottom) -
        getDistance(price, b.top, b.bottom)
      );
    });

  const block = validBlocks[0];

  let obScore = 0;

  if (block) {
    obScore += 10;
    result.confluence.push("Order Block");

    result.evidence.push({
      type: "ORDER_BLOCK",
      top: block.top,
      bottom: block.bottom,
      status: block.status
    });
  }

  // --------------------------------------------------
  // 5. FAIR VALUE GAP
  // --------------------------------------------------

  const relevantFvg = (analysis.fvg ?? [])
    .filter(fvg => {
      if (fvg.direction !== trend) return false;

      if (
        !["unmitigated", "partially_mitigated"].includes(
          fvg.status
        )
      ) return false;

      const top = finite(fvg.top);
      const bottom = finite(fvg.bottom);

      if (top === null || bottom === null || top <= bottom) {
        return false;
      }

      return (
        price >= bottom - atr &&
        price <= top + atr
      );
    })
    .sort((a, b) => {
      return (
        getDistance(price, a.top, a.bottom) -
        getDistance(price, b.top, b.bottom)
      );
    })[0];

  if (relevantFvg) {
    obScore += 5;

    result.confluence.push("Fair Value Gap");

    result.evidence.push({
      type: "FVG",
      top: relevantFvg.top,
      bottom: relevantFvg.bottom,
      status: relevantFvg.status
    });
  }

  scores.fvg_ob = obScore;

  // --------------------------------------------------
  // 6. SUPPLY AND DEMAND
  // --------------------------------------------------

  const recentSwings = (analysis.swings ?? []).slice(-10);

  const validSD = recentSwings.find(sw => {
    const swingPrice = finite(sw.price);

    if (swingPrice === null || !sw.unmitigated) {
      return false;
    }

    if (
      trend === "bullish" &&
      sw.type === "low"
    ) {
      return Math.abs(price - swingPrice) <= atr * 1.5;
    }

    if (
      trend === "bearish" &&
      sw.type === "high"
    ) {
      return Math.abs(price - swingPrice) <= atr * 1.5;
    }

    return false;
  });

  if (validSD) {
    scores.supply_demand = 15;
    result.is_sd = true;

    result.confluence.push(
      trend === "bullish" ? "Demand Zone" : "Supply Zone"
    );
  }

  // --------------------------------------------------
  // 7. LIQUIDITY SWEEP
  // --------------------------------------------------

  const relevantSweep = [...(analysis.sweeps ?? [])]
    .filter(sweep => {
      const index = finite(sweep.index);

      return (
        sweep.direction === trend &&
        index !== null &&
        lastIndex - index >= 0 &&
        lastIndex - index <= MAX_EVENT_AGE
      );
    })
    .sort((a, b) => b.index - a.index)[0];

  if (relevantSweep) {
    scores.liquidity = 20;

    result.confluence.push("Liquidity Sweep");

    result.evidence.push({
      type: "LIQUIDITY_SWEEP",
      index: relevantSweep.index,
      direction: relevantSweep.direction
    });
  }

  // --------------------------------------------------
  // 8. SESSION FILTER
  // --------------------------------------------------

  const sessionTimestamp =
    options.timestamp ??
    analysis.latestCandleTime ??
    Date.now();

  const session = getTradingSession(sessionTimestamp);

  result.session = session;

  if (session === "ASIAN") {
    result.reasons.push(
      "Signal rejected: Asian session filter."
    );
    return result;
  }

  if (session === "LONDON" || session === "NEW_YORK") {
    scores.session = 10;

    result.confluence.push(
      session === "LONDON"
        ? "London Session"
        : "New York Session"
    );
  }

  // --------------------------------------------------
  // 9. SCORE CALCULATION
  // --------------------------------------------------

  result.score = Object.values(scores).reduce(
    (total, value) => total + value,
    0
  );

  // --------------------------------------------------
  // 10. QUALITY VALIDATION
  // --------------------------------------------------

  if (result.score < MIN_SIGNAL_SCORE) {
    result.reasons.push(
      `Score ${result.score}/100 is below minimum ${MIN_SIGNAL_SCORE}.`
    );

    result.confidenceLabel = "Insufficient confluence";

    return result;
  }

  // --------------------------------------------------
  // 11. ENTRY ZONE
  // --------------------------------------------------

  result.candidateZone = block
    ? {
        top: Number(block.top),
        bottom: Number(block.bottom),
        orderBlockTime: block.time,
        status: block.status
      }
    : null;

  let entry;

  if (block) {
    // Bullish: entry at upper boundary.
    // Bearish: entry at lower boundary.
    entry = trend === "bullish"
      ? Number(block.top)
      : Number(block.bottom);

    const insideZone =
      price >= Number(block.bottom) &&
      price <= Number(block.top);

    result.entryStatus = insideZone
      ? "INSIDE_ENTRY_ZONE"
      : "WAITING_FOR_RETEST";

    if (!insideZone) {
      result.reasons.push(
        "Price has not returned to the selected order block."
      );
    }
  } else {
    entry = price;
    result.entryStatus = "MARKET_ENTRY";
  }

  // --------------------------------------------------
  // 12. STRUCTURAL STOP LOSS
  // --------------------------------------------------

  let stopLoss;

  if (block) {
    const buffer = atr * STOP_BUFFER_ATR;

    const structuralSL = trend === "bullish"
      ? Number(block.bottom) - buffer
      : Number(block.top) + buffer;

    const minimumDistance = atr * MIN_STOP_ATR;

    if (trend === "bullish") {
      stopLoss = Math.min(
        structuralSL,
        entry - minimumDistance
      );
    } else {
      stopLoss = Math.max(
        structuralSL,
        entry + minimumDistance
      );
    }
  } else {
    const buffer = atr * 2;

    stopLoss = trend === "bullish"
      ? entry - buffer
      : entry + buffer;
  }

  const risk = Math.abs(entry - stopLoss);

  if (
    !Number.isFinite(risk) ||
    risk <= 0 ||
    !Number.isFinite(entry)
  ) {
    result.reasons.push("Invalid structural stop-loss.");
    return result;
  }

  // --------------------------------------------------
  // 13. TAKE PROFIT CALCULATION
  // --------------------------------------------------

  // TP1 = 1:2
  // TP2 = 1:3
  // TP3 = 1:4

  const multiplier = trend === "bullish" ? 1 : -1;

  const tp1 = entry + multiplier * risk * 2;
  const tp2 = entry + multiplier * risk * 3;
  const tp3 = entry + multiplier * risk * 4;

  // --------------------------------------------------
  // 14. FINAL LEVEL VALIDATION
  // --------------------------------------------------

  const levels = [
    entry,
    stopLoss,
    tp1,
    tp2,
    tp3
  ];

  if (!levels.every(Number.isFinite)) {
    result.reasons.push("Invalid calculated trade levels.");
    return result;
  }

  if (trend === "bullish") {
    if (!(stopLoss < entry && entry < tp1 && tp1 < tp2 && tp2 < tp3)) {
      result.reasons.push("Invalid BUY price structure.");
      return result;
    }
  } else {
    if (!(stopLoss > entry && entry > tp1 && tp1 > tp2 && tp2 > tp3)) {
      result.reasons.push("Invalid SELL price structure.");
      return result;
    }
  }

  result.levels = {
    entry,
    stop_loss: stopLoss,
    take_profit: [tp1, tp2, tp3],
    risk,
    reward: Math.abs(tp3 - entry),
    risk_reward: 4
  };

  // --------------------------------------------------
  // 15. FINAL SIGNAL
  // --------------------------------------------------

  result.decision = result.direction;
  result.confidence = result.score;

  result.quality = result.score >= 80
    ? "HIGH"
    : "GOOD";

  result.confidenceLabel = result.score >= 80
    ? "High Quality Setup"
    : "Good Setup";

  if (block && result.entryStatus === "WAITING_FOR_RETEST") {
    result.reasons.push(
      "Signal is valid as a setup, but entry is pending a retest."
    );
  }

  return result;
}
