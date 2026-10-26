import { getMarketData } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";
import { runAgent } from "./agent.js";

export async function runSignalEngine(env, symbol = "XAUUSD", tfKey = "M15") {
  console.log(`[ENGINE] Starting analysis for ${symbol} ${tfKey}`);

  try {
    // 1. Fetch Data
    const data = await getMarketData(env, symbol, tfKey, 300);
    if (!data.ok) throw new Error("Data fetch failed: " + JSON.stringify(data.error));

    // 2. Run SMC Math
    const analysis = analyze(data.candles, tfKey);
    if (!analysis.ok) throw new Error("Analysis failed: " + analysis.message);

    const currentPrice = analysis.lastClosedCandle.close;
    
    // 3. Find Active Order Block
    const activeOB = analysis.orderBlocks.find(ob => {
      const distance = Math.abs(currentPrice - ob.high) / currentPrice;
      return distance < 0.005; // Price is within 0.5% of the OB
    });

    if (!activeOB) {
      return console.log(`[ENGINE] No active OB near ${currentPrice}. No signal generated.`);
    }

    // 4. Calculate Trade Parameters
    const isBuy = analysis.trend === "BULLISH";
    const entry = isBuy ? activeOB.high : activeOB.low;
    const atrBuffer = analysis.atr.value * 0.5;
    
    const stopLoss = isBuy ? activeOB.low - atrBuffer : activeOB.high + atrBuffer;
    const risk = Math.abs(entry - stopLoss);
    const takeProfit = isBuy ? entry + (risk * 2) : entry - (risk * 2); // 1:2 Risk/Reward

    console.log(`[ENGINE] Found setup: ${isBuy ? 'BUY' : 'SELL'} ${symbol} @ ${entry}`);

    // 5. AI News Check
    const prompt = `I am about to take a ${isBuy ? 'BUY' : 'SELL'} on ${symbol}. Entry: ${entry.toFixed(5)}, SL: ${stopLoss.toFixed(5)}. Search the news. Is there any high-impact news in the next 2 hours that would invalidate this trade?`;
    
    const aiResponse = await runAgent(env, "system", prompt);
    
    let aiDecision = { recommendation: "BLOCK", reason: "Failed to parse AI response" };
    try {
      const match = aiResponse.reply.match(/\{[\s\S]*\}/);
      if (match) aiDecision = JSON.parse(match[0]);
    } catch (e) {
      console.log("[ENGINE] AI Parse Error:", aiResponse.reply);
    }

    if (aiDecision.recommendation !== "APPROVE") {
      return console.log(`[ENGINE] Trade BLOCKED by News AI: ${aiDecision.reason}`);
    }

    // 6. Send to Telegram
    const message = `
🚨 **SKY AI SIGNAL** 🚨
Pair: **${symbol}** (${tfKey})
Direction: **${isBuy ? 'BUY 🟢' : 'SELL 🔴'}**
Entry: ${entry.toFixed(5)}
Stop Loss: ${stopLoss.toFixed(5)}
Take Profit: ${takeProfit.toFixed(5)}
RR: 1:2

🧠 **News Check:** ${aiDecision.reason}
    `;

    const tgRes = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" })
    });

    if (!tgRes.ok) throw new Error("Telegram send failed.");
    console.log(`[ENGINE] Signal successfully sent to Telegram!`);

  } catch (error) {
    console.error("[ENGINE ERROR]", error.message);
  }
}
