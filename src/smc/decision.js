const MAX_ZONE_DISTANCE_ATR = 1.5;
const MAX_EVENT_AGE = 20;

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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

export function buildChartAnnotations(analysis, decision = null) {
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
      id: "DEALING_RANGE",
      type: "DEALING_RANGE",
      top: range.high,
      bottom: range.low,
      label: "Dealing range",
      reason: range.why
    });

    annotations.push({
      id: "EQUILIBRIUM",
      type: "EQUILIBRIUM",
      price: finite(range.equilibrium),
      label: "50% equilibrium",
      reason: "Midpoint of the selected dealing range."
    });
  }

  if (decision?.levels) {
    for (const [key, value] of Object.entries(decision.levels)) {
      if (Array.isArray(value)) {
        // Handle multiple take profits
        value.forEach((v, i) => {
          if (finite(v) === null) return;
          annotations.push({
            id: `${key.toUpperCase()}_${i + 1}`,
            type: key.toUpperCase(),
            price: Number(v),
            label: `${key.replaceAll("_", " ").toUpperCase()} ${i + 1}`,
            direction: decision.direction ?? null
          });
        });
      } else {
        if (finite(value) === null) continue;
        annotations.push({
          id: key.toUpperCase(),
          type: key.toUpperCase(),
          price: Number(value),
          label: key.replaceAll("_", " ").toUpperCase(),
          direction: decision.direction ?? null
        });
      }
    }
  }

  return annotations;
}

export function evaluateSetup(analysis, currentPrice) {
  const price = finite(currentPrice);
  const atr = finite(analysis.atr?.value);
  const trend = String(analysis.trend ?? "").toLowerCase();

  const result = {
    decision: "NO_TRADE",
    direction: null,
    score: 0,
    maxScore: 100,
    confidence: 0,
    quality: null,
    confidenceLabel: "Insufficient evidence",
    reasons: [],
    confluence: [],
    evidence: [],
    candidateZone: null,
    levels: null,
    entryStatus: "NOT_CONFIRMED"
  };

  if (price === null || price <= 0 || atr === null || atr <= 0) {
    result.reasons.push("Invalid current price or ATR.");
    return result;
  }

  if (trend !== "bullish" && trend !== "bearish") {
    result.reasons.push(`Market structure is ${trend || "unknown"}.`);
    return result;
  }

  result.direction = trend === "bullish" ? "BUY" : "SELL";
  result.evidence.push(`Latest structure trend is ${trend}.`);
  result.score += 20; // 20 pts for Trend
  result.confluence.push(`${trend.charAt(0).toUpperCase() + trend.slice(1)} Trend`);

  const lastIndex = analysis.candlesAnalysed - 1;

  // 1. Market Structure Shift (BOS / CHOCH) - 20 pts
  const recentEvent = [...(analysis.structureEvents ?? [])]
    .filter(event =>
      event.direction === trend &&
      lastIndex - event.index >= 0 &&
      lastIndex - event.index <= MAX_EVENT_AGE
    )
    .sort((a, b) => b.index - a.index)[0];

  if (recentEvent) {
    result.score += 20;
    result.evidence.push(`Recent ${recentEvent.type} confirms ${trend} structure.`);
    result.confluence.push(`${recentEvent.type} Confirmed`);
  } else {
    result.reasons.push(`No matching BOS/CHOCH event in the last ${MAX_EVENT_AGE} candles.`);
  }

  // 2. Order Block - 20 pts
  const validBlocks = (analysis.orderBlocks ?? [])
    .filter(ob => {
      if (ob.direction !== trend) return false;
      if (!["unmitigated", "mitigated"].includes(ob.status)) return false;
      const top = finite(ob.top);
      const bottom = finite(ob.bottom);
      if (top === null || bottom === null || top <= bottom) return false;
      const distance = price < bottom ? bottom - price : price > top ? price - top : 0;
      return distance <= atr * MAX_ZONE_DISTANCE_ATR;
    })
    .sort((a, b) => {
      const distance = ob => price < ob.bottom ? ob.bottom - price : price > ob.top ? price - ob.top : 0;
      return distance(a) - distance(b);
    });

  const block = validBlocks[0];

  if (!block) {
    result.reasons.push("No valid nearby order block agrees with the current trend.");
    return result; // Exit early, no OB means no trade
  }

  result.score += 20;
  result.evidence.push(`A ${trend} order block is nearby (${block.status}).`);
  result.confluence.push("Order Block");

  // 3. Liquidity Sweep - 15 pts
  const relevantSweep = [...(analysis.sweeps ?? [])]
    .filter(sweep =>
      sweep.direction === trend &&
      lastIndex - sweep.index >= 0 &&
      lastIndex - sweep.index <= MAX_EVENT_AGE
    )
    .sort((a, b) => b.index - a.index)[0];

  if (relevantSweep) {
    result.score += 15;
    result.evidence.push(`Recent ${relevantSweep.side}-side liquidity sweep supports the setup.`);
    result.confluence.push("Liquidity Sweep");
  } else {
    result.reasons.push("No recent matching liquidity sweep.");
  }

  // 4. Fair Value Gap (FVG) - 15 pts
  const relevantFvg = (analysis.fvg ?? []).find(fvg => {
    if (fvg.direction !== trend) return false;
    if (!["unmitigated", "partially_mitigated"].includes(fvg.status)) return false;
    const top = finite(fvg.top);
    const bottom = finite(fvg.bottom);
    if (top === null || bottom === null) return false;
    return price >= bottom - atr && price <= top + atr;
  });

  if (relevantFvg) {
    result.score += 15;
    result.evidence.push(`A nearby ${trend} fair value gap provides confluence.`);
    result.confluence.push("Fair Value Gap");
  } else {
    result.reasons.push("No nearby valid matching FVG.");
  }

  // 5. Premium / Discount Zone - 10 pts
  const range = analysis.dealingRange;
  if (range?.valid && !range.outside) {
    const locationSupportsDirection = trend === "bullish" ? range.zone === "discount" : range.zone === "premium";
    if (locationSupportsDirection) {
      result.score += 10;
      result.evidence.push(`${range.zone} pricing supports the ${result.direction} idea.`);
      result.confluence.push(`${range.zone.charAt(0).toUpperCase() + range.zone.slice(1)} Zone`);
    } else {
      result.reasons.push(`Price is in ${range.zone}; this does not support the preferred ${result.direction} location.`);
    }
  } else {
    result.reasons.push("A valid in-range premium/discount location is unavailable.");
  }

  result.candidateZone = {
    top: Number(block.top),
    bottom: Number(block.bottom),
    orderBlockTime: block.time,
    status: block.status
  };

  // Build the Entry, SL, and multiple TPs
  const entry = trend === "bullish" ? Number(block.top) : Number(block.bottom);
  const buffer = atr * 0.25;
  const stopLoss = trend === "bullish" ? Number(block.bottom) - buffer : Number(block.top) + buffer;
  const risk = Math.abs(entry - stopLoss);

  if (!(risk > 0) || !Number.isFinite(risk)) {
    result.reasons.push("Unable to calculate a valid stop-loss.");
    result.decision = "NO_TRADE";
    return result;
  }

  // Calculate 3 Take Profits (1:1, 1:2, 1:3 R:R)
  const tp1 = trend === "bullish" ? entry + (1 * risk) : entry - (1 * risk);
  const tp2 = trend === "bullish" ? entry + (2 * risk) : entry - (2 * risk);
  const tp3 = trend === "bullish" ? entry + (3 * risk) : entry - (3 * risk);

  // ✅ THE EXACT FORMAT THE KOTLIN APP EXPECTS
  result.levels = {
    entry: entry,
    stop_loss: stopLoss,
    take_profit: [tp1, tp2, tp3] // Array of TPs for the app
  };

  // 🛑 QUALITY FILTER: Only send to the app if the score is 65 or above
  if (result.score >= 65 && recentEvent) {
    result.decision = trend === "bullish" ? "BUY" : "SELL";
    result.confidence = result.score;
    
    // Assign Grade based on score
    if (result.score >= 90) result.quality = "A+";
    else if (result.score >= 80) result.quality = "A";
    else result.quality = "B";

    result.confidenceLabel = `${result.quality} Setup`;
    result.reasons = ["All high-probability conditions met."]; // Clear rejection reasons
  } else {
    result.decision = "NO_TRADE";
    result.confidenceLabel = "Insufficient confluence";
    result.reasons.push(`Score ${result.score}/100 did not pass the minimum threshold of 65.`);
  }

  return result;
}
