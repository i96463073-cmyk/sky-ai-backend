const MAX_ZONE_DISTANCE_ATR = 2.5; 
const MAX_EVENT_AGE = 40;          

function finite(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function addAnnotation(out, type, item, extra = {}) {
  if (!item) return;
  out.push({
    id: `${type}-${item.index ?? item.candleIndex ?? item.confirmIndex ?? item.time ?? out.length}`,
    type, time: item.time ?? null, index: item.index ?? item.candleIndex ?? item.confirmIndex ?? null,
    price: finite(item.price ?? item.level), top: finite(item.top ?? item.high), bottom: finite(item.bottom ?? item.low),
    direction: item.direction ?? null, label: type.replaceAll("_", " "), reason: item.why ?? "", ...extra
  });
}

export function buildChartAnnotations(analysis, decision = null) {
  const annotations = [];
  for (const swing of analysis.swings ?? []) addAnnotation(annotations, "SWING", swing, { label: swing.label ? `${swing.label} ${swing.type}` : `Swing ${swing.type}` });
  for (const event of analysis.structureEvents ?? []) addAnnotation(annotations, event.type, event, { label: `${event.type} ${event.direction}`, startTime: event.swingTime, startIndex: event.swingIndex });
  for (const pool of analysis.liquidityPools ?? []) addAnnotation(annotations, "LIQUIDITY", pool, { label: `${pool.kind} ${pool.side}-side liquidity`, formedIndex: pool.formedIndex, status: pool.status });
  for (const sweep of analysis.sweeps ?? []) addAnnotation(annotations, "LIQUIDITY_SWEEP", sweep, { label: `${sweep.side}-side liquidity swept` });
  for (const ob of analysis.orderBlocks ?? []) addAnnotation(annotations, "ORDER_BLOCK", ob, { label: `${ob.direction} order block`, startTime: ob.time, startIndex: ob.candleIndex, endIndex: ob.mitigatedIndex, status: ob.status });
  for (const fvg of analysis.fvg ?? []) addAnnotation(annotations, "FVG", fvg, { label: `${fvg.direction} fair value gap`, startTime: fvg.time, startIndex: fvg.index, endIndex: fvg.mitigatedIndex, status: fvg.status });

  const range = analysis.dealingRange;
  if (range?.valid) {
    annotations.push({ id: "DEALING_RANGE", type: "DEALING_RANGE", top: range.high, bottom: range.low, label: "Dealing range", reason: range.why });
    annotations.push({ id: "EQUILIBRIUM", type: "EQUILIBRIUM", price: finite(range.equilibrium), label: "50% equilibrium", reason: "Midpoint of the selected dealing range." });
  }

  if (decision?.levels) {
    for (const [key, value] of Object.entries(decision.levels)) {
      if (Array.isArray(value)) {
        value.forEach((v, i) => {
          if (finite(v) === null) return;
          annotations.push({ id: `${key.toUpperCase()}_${i + 1}`, type: key.toUpperCase(), price: Number(v), label: `${key.replaceAll("_", " ").toUpperCase()} ${i + 1}`, direction: decision.direction ?? null });
        });
      } else {
        if (finite(value) === null) continue;
        annotations.push({ id: key.toUpperCase(), type: key.toUpperCase(), price: Number(value), label: key.replaceAll("_", " ").toUpperCase(), direction: decision.direction ?? null });
      }
    }
  }
  return annotations;
}

export function evaluateSetup(analysis, currentPrice) {
  const price = finite(currentPrice);
  const atr = finite(analysis.atr?.value);
  const trend = String(analysis.trend ?? "").toLowerCase();

  // Breakdown Scores (Total 100)
  const scores = {
    htf: 0,       // Max 20
    liquidity: 0, // Max 20
    structure: 0, // Max 20
    fvg_ob: 0,    // Max 20
    session: 0    // Max 20
  };

  const result = { decision: "NO_TRADE", direction: null, score: 0, maxScore: 100, confidence: 0, quality: null, breakdown: scores, confidenceLabel: "Insufficient evidence", reasons: [], confluence: [], evidence: [], candidateZone: null, levels: null, entryStatus: "NOT_CONFIRMED" };

  if (price === null || price <= 0 || atr === null || atr <= 0) { result.reasons.push("Invalid current price or ATR."); return result; }
  if (trend !== "bullish" && trend !== "bearish") { result.reasons.push(`Market structure is ${trend || "unknown"}.`); return result; }

  result.direction = trend === "bullish" ? "BUY" : "SELL";

  // 1. HTF Alignment (Using trend as proxy)
  scores.htf = 20;
  result.confluence.push(`${trend.charAt(0).toUpperCase() + trend.slice(1)} Trend`);

  const lastIndex = analysis.candlesAnalysed - 1;

  // 2. Market Structure
  const recentEvent = [...(analysis.structureEvents ?? [])]
    .filter(event => event.direction === trend && lastIndex - event.index >= 0 && lastIndex - event.index <= MAX_EVENT_AGE)
    .sort((a, b) => b.index - a.index)[0];

  if (recentEvent) {
    scores.structure = 18;
    result.confluence.push(`${recentEvent.type} Confirmed`);
  }

  // 3. Order Block & FVG (FVG/OB confirmation)
  const validBlocks = (analysis.orderBlocks ?? [])
    .filter(ob => {
      if (ob.direction !== trend) return false;
      if (!["unmitigated", "mitigated"].includes(ob.status)) return false;
      const top = finite(ob.top), bottom = finite(ob.bottom);
      if (top === null || bottom === null || top <= bottom) return false;
      const distance = price < bottom ? bottom - price : price > top ? price - top : 0;
      return distance <= atr * MAX_ZONE_DISTANCE_ATR;
    })
    .sort((a, b) => {
      const distance = ob => price < ob.bottom ? ob.bottom - price : price > ob.top ? price - ob.top : 0;
      return distance(a) - distance(b);
    });

  const block = validBlocks[0];
  if (!block) { result.reasons.push("No valid nearby order block."); return result; }

  let obScore = 10;
  let fvgScore = 0;
  result.confluence.push("Order Block");

  const relevantFvg = (analysis.fvg ?? []).find(fvg => {
    if (fvg.direction !== trend) return false;
    if (!["unmitigated", "partially_mitigated"].includes(fvg.status)) return false;
    const top = finite(fvg.top), bottom = finite(fvg.bottom);
    if (top === null || bottom === null) return false;
    return price >= bottom - atr && price <= top + atr;
  });

  if (relevantFvg) {
    fvgScore = 8;
    result.confluence.push("Fair Value Gap");
  }
  scores.fvg_ob = obScore + fvgScore;

  // 4. Liquidity
  const relevantSweep = [...(analysis.sweeps ?? [])]
    .filter(sweep => sweep.direction === trend && lastIndex - sweep.index >= 0 && lastIndex - sweep.index <= MAX_EVENT_AGE)
    .sort((a, b) => b.index - a.index)[0];

  if (relevantSweep) {
    scores.liquidity = 18;
    result.confluence.push("Liquidity Sweep");
  }

  // 5. Session & News (Killzones in Kenyan Time EAT UTC+3)
  // London: 11:00 - 15:00 EAT
  // New York: 16:00 - 20:00 EAT
  const now = new Date();
  const eatHour = (now.getUTCHours() + 3) % 24;
  const isLondon = eatHour >= 11 && eatHour < 15;
  const isNewYork = eatHour >= 16 && eatHour < 20;
  
  if (isLondon || isNewYork) {
    scores.session = 14;
    result.confluence.push(isLondon ? "London Killzone" : "NY Killzone");
  } else {
    result.reasons.push("Outside Killzones (Low volume session)");
  }

  // Build the levels
  result.candidateZone = { top: Number(block.top), bottom: Number(block.bottom), orderBlockTime: block.time, status: block.status };
  const entry = trend === "bullish" ? Number(block.top) : Number(block.bottom);
  const buffer = atr * 0.25;
  const stopLoss = trend === "bullish" ? Number(block.bottom) - buffer : Number(block.top) + buffer;
  const risk = Math.abs(entry - stopLoss);

  if (!(risk > 0) || !Number.isFinite(risk)) { result.reasons.push("Invalid stop-loss."); return result; }

  const tp1 = trend === "bullish" ? entry + (1 * risk) : entry - (1 * risk);
  const tp2 = trend === "bullish" ? entry + (2 * risk) : entry - (2 * risk);
  const tp3 = trend === "bullish" ? entry + (3 * risk) : entry - (3 * risk);

  result.levels = { entry: entry, stop_loss: stopLoss, take_profit: [tp1, tp2, tp3] };

  // Calculate total score
  result.score = scores.htf + scores.liquidity + scores.structure + scores.fvg_ob + scores.session;

  if (result.score >= 80) {
    result.decision = result.direction;
    result.confidence = result.score;
    result.quality = "HIGH";
    result.confidenceLabel = "High Quality Setup";
  } else if (result.score >= 60) {
    result.decision = result.direction;
    result.confidence = result.score;
    result.quality = "GOOD";
    result.confidenceLabel = "Good Setup";
  } else if (result.score >= 40) {
    result.decision = result.direction;
    result.confidence = result.score;
    result.quality = "STANDARD";
    result.confidenceLabel = "Standard Setup";
  } else {
    result.decision = "NO_TRADE";
    result.confidenceLabel = "Insufficient confluence";
    result.reasons.push(`Score ${result.score}/100 did not pass threshold.`);
  }

  return result;
                            }
