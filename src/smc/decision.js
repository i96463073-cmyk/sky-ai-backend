export function evaluateSetup(analysis, currentPrice) {
  const price = finite(currentPrice);
  const atr = finite(analysis.atr?.value);
  const trend = String(analysis.trend ?? "").toLowerCase();

  const scores = { htf: 0, liquidity: 0, structure: 0, fvg_ob: 0, supply_demand: 0, session: 0 };
  const result = { decision: "NO_TRADE", direction: null, score: 0, maxScore: 100, confidence: 0, quality: null, breakdown: scores, is_sd: false, confidenceLabel: "Insufficient evidence", reasons: [], confluence: [], evidence: [], candidateZone: null, levels: null, entryStatus: "NOT_CONFIRMED" };

  if (price === null || price <= 0 || atr === null || atr <= 0) { result.reasons.push("Invalid current price or ATR."); return result; }
  if (trend !== "bullish" && trend !== "bearish") { result.reasons.push(`Market structure is ${trend || "unknown"}.`); return result; }

  result.direction = trend === "bullish" ? "BUY" : "SELL";

  // 1. HTF Alignment (20 pts)
  scores.htf = 20;
  result.confluence.push(`${trend.charAt(0).toUpperCase() + trend.slice(1)} Trend`);

  const lastIndex = analysis.candlesAnalysed - 1;

  // 2. Market Structure (20 pts)
  const recentEvent = [...(analysis.structureEvents ?? [])]
    .filter(event => event.direction === trend && lastIndex - event.index >= 0 && lastIndex - event.index <= MAX_EVENT_AGE)
    .sort((a, b) => b.index - a.index)[0];

  if (recentEvent) {
    scores.structure = 20;
    result.confluence.push(`${recentEvent.type} Confirmed`);
  }

  // 3. Order Block & FVG (15 pts)
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
  let obScore = 0;
  if (block) {
    obScore += 10;
    result.confluence.push("Order Block");
  }

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

  // 4. Supply & Demand Zones (15 pts)
  const recentSwings = (analysis.swings ?? []).slice(-10);
  const validSD = recentSwings.find(sw => {
    if (trend === "bullish" && sw.type === "low" && sw.unmitigated) {
      const dist = Math.abs(price - sw.price);
      return dist <= atr * 1.5;
    }
    if (trend === "bearish" && sw.type === "high" && sw.unmitigated) {
      const dist = Math.abs(price - sw.price);
      return dist <= atr * 1.5;
    }
    return false;
  });

  if (validSD) {
    scores.supply_demand = 15;
    result.is_sd = true;
    result.confluence.push(trend === "bullish" ? "Demand Zone" : "Supply Zone");
  }

  // 5. Liquidity (20 pts)
  const relevantSweep = [...(analysis.sweeps ?? [])]
    .filter(sweep => sweep.direction === trend && lastIndex - sweep.index >= 0 && lastIndex - sweep.index <= MAX_EVENT_AGE)
    .sort((a, b) => b.index - a.index)[0];

  if (relevantSweep) {
    scores.liquidity = 20;
    result.confluence.push("Liquidity Sweep");
  }

  // 6. Session (10 pts) + ASIAN SESSION FILTER
  const now = new Date();
  const eatHour = (now.getUTCHours() + 3) % 24;
  
  // Define killzones based on EAT
  const isAsian = eatHour >= 2 && eatHour < 10;   // 02:00 - 10:00 EAT (Tokyo/Sydney overlap)
  const isLondon = eatHour >= 10 && eatHour < 15; // 10:00 - 15:00 EAT
  const isNewYork = eatHour >= 16 && eatHour < 20; // 16:00 - 20:00 EAT

  // REJECT: Block all trades during Asian session to avoid low-volume chop
  if (isAsian) {
    result.reasons.push("Signal rejected: Asian Session (Low liquidity/chop).");
    return result; 
  }

  // AWARD POINTS: If it's London or NY, give the bonus points
  if (isLondon || isNewYork) {
    scores.session = 10;
    result.confluence.push(isLondon ? "London Session" : "NY Session");
  }


  // ==========================================
  // SMART STOP LOSS & RISK:REWARD
  // ==========================================
  result.candidateZone = block ? { top: Number(block.top), bottom: Number(block.bottom), orderBlockTime: block.time, status: block.status } : null;
  
  let entry = block ? (trend === "bullish" ? Number(block.top) : Number(block.bottom)) : price;
  let stopLoss = 0;

  if (block) {
    // Place SL behind the Order Block + 20% ATR buffer
    const buffer = atr * 0.2; 
    let structuralSL = trend === "bullish" ? Number(block.bottom) - buffer : Number(block.top) + buffer;
    
    // Ensure minimum distance of 1.5 * ATR to survive market noise
    const minDistance = atr * 1.5;
    const currentDistance = Math.abs(entry - structuralSL);
    
    if (currentDistance < minDistance) {
      stopLoss = trend === "bullish" ? entry - minDistance : entry + minDistance;
    } else {
      stopLoss = structuralSL;
    }
  } else {
    // No block? Use a wider safety net (2x ATR) to survive noise
    const buffer = atr * 2.0; 
    stopLoss = trend === "bullish" ? entry - buffer : entry + buffer;
  }

  const risk = Math.abs(entry - stopLoss);
  if (!(risk > 0) || !Number.isFinite(risk)) { result.reasons.push("Invalid stop-loss."); return result; }

  // Changed Risk:Reward to 1.5R, 2.5R, 4.0R globally
  const tp1 = trend === "bullish" ? entry + (1.5 * risk) : entry - (1.5 * risk);
  const tp2 = trend === "bullish" ? entry + (2.5 * risk) : entry - (2.5 * risk);
  const tp3 = trend === "bullish" ? entry + (4.0 * risk) : entry - (4.0 * risk);

  result.levels = { entry: entry, stop_loss: stopLoss, take_profit: [tp1, tp2, tp3] };


  // ==========================================
  // STRICTER SCORING
  // ==========================================
  result.score = scores.htf + scores.liquidity + scores.structure + scores.fvg_ob + scores.supply_demand + scores.session;

  if (result.score >= 80) {
    result.decision = result.direction;
    result.confidence = result.score;
    result.quality = "HIGH";
    result.confidenceLabel = "High Quality Setup";
  } else if (result.score >= 65) { // Minimum score raised to 65
    result.decision = result.direction;
    result.confidence = result.score;
    result.quality = "GOOD";
    result.confidenceLabel = "Good Setup";
  } else {
    // Removed the 50-point standard tier. If it's not a Good or High setup, it's a NO_TRADE.
    result.decision = "NO_TRADE";
    result.confidenceLabel = "Insufficient confluence";
    result.reasons.push(`Score ${result.score}/100 did not pass the minimum threshold of 65.`);
  }

  return result;
}
