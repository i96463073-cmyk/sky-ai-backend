import { getMarketData } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";
import { runAgent } from "./agent.js";

export async function runSignalEngine(env, symbol = "XAUUSD", tfKey = "M15") {
  try {
    // 1. Fetch Data
    const data = await getMarketData(env, symbol, tfKey, 300);
    if (!data.ok) return "ERROR: Data fetch failed - " + JSON.stringify(data.error);

    // 2. Run SMC Math
    const analysis = analyze(data.candles, tfKey);
    if (!analysis.ok) return "ERROR: Analysis failed - " + analysis.message;

    const currentPrice = Number(analysis.lastClosedCandle.close);
    
    // 3. Find Active Order Block (Strict 0.5% distance rule restored)
    const activeOB = analysis.orderBlocks.find(ob => {
      const obHigh = ob.high || ob.top || currentPrice;
      const distance = Math.abs(currentPrice - obHigh) / currentPrice;
      return distance < 0.005; 
    });

    if (!activeOB) {
      return `No active Order Block near price (${currentPrice}). No signal generated.`;
    }

    // 4. Calculate Trade Parameters
    const isBuy = analysis.trend === "BULLISH";
    const obHigh = Number(activeOB.high || activeOB.top || currentPrice);
    const obLow = Number(activeOB.low || activeOB.bottom || currentPrice);
    const atrBuffer = Number(analysis.atr?.value || 2) * 0.5;
    
    const entry = isBuy ? obHigh : obLow;
    const stopLoss = isBuy ? (obLow - atrBuffer) : (obHigh + atrBuffer);
    const risk = Math.abs(entry - stopLoss);
    const takeProfit = isBuy ? (entry + (risk * 2)) : (entry - (risk * 2)); 

    const safeEntry = Number(entry) || currentPrice;
    const safeSL = Number(stopLoss) || (currentPrice - 5);
    const safeTP = Number(takeProfit) || (currentPrice + 10);

    // 5. Real AI News Check
    const prompt = `I am about to take a ${isBuy ? 'BUY' : 'SELL'} on ${symbol}. Entry: ${safeEntry.toFixed(5)}, SL: ${safeSL.toFixed(5)}. Search the news. Is there any high-impact news in the next 2 hours that would invalidate this trade? Reply ONLY in JSON format: {"recommendation": "APPROVE" | "BLOCK", "reason": "..."}`;
    
    const aiResponse = await runAgent(env, "system", prompt);
    
    let aiDecision = { recommendation: "BLOCK", reason: "Failed to parse AI response" };
    try {
      const match = aiResponse.reply.match(/\{[\s\S]*\}/);
      if (match) aiDecision = JSON.parse(match[0]);
    } catch (e) {
      return "Trade BLOCKED: AI returned invalid JSON format.";
    }

    if (aiDecision.recommendation !== "APPROVE") {
      return `Trade BLOCKED by News AI: ${aiDecision.reason}`;
    }

    // 6. Send to Telegram
    const message = `
🚨 **SKY AI SIGNAL** 🚨
Pair: **${symbol}** (${tfKey})
Direction: **${isBuy ? 'BUY 🟢' : 'SELL 🔴'}**
Entry: ${safeEntry.toFixed(5)}
Stop Loss: ${safeSL.toFixed(5)}
Take Profit: ${safeTP.toFixed(5)}
RR: 1:2

🧠 **News Check:** ${aiDecision.reason}
    `;

    const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" })
    });

    if (!tgRes.ok) {
      const tgError = await tgRes.text();
      return "ERROR: Telegram send failed. Details: " + tgError;
    }

    return `SUCCESS! Real signal sent to Telegram.\n\n${isBuy ? 'BUY' : 'SELL'} ${symbol} at ${safeEntry.toFixed(5)}`;

  } catch (error) {
    return "CRITICAL ERROR: " + error.message;
  }
}
