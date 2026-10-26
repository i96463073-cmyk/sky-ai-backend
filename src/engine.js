import { getMarketData } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";

export async function runSignalEngine(env, symbol = "XAUUSD", tfKey = "M15") {
  try {
    // 1. Fetch Data
    const data = await getMarketData(env, symbol, tfKey, 300);
    if (!data.ok) return "ERROR: Data fetch failed - " + JSON.stringify(data.error);

    // 2. Run SMC Math
    const analysis = analyze(data.candles, tfKey);
    if (!analysis.ok) return "ERROR: Analysis failed - " + analysis.message;

    const currentPrice = analysis.lastClosedCandle.close;
    
    // 3. Find Active Order Block (FORCE TEST: We use 0.5 instead of 0.005)
    let activeOB = analysis.orderBlocks.find(ob => {
      const distance = Math.abs(currentPrice - ob.high) / currentPrice;
      return distance < 0.5; 
    });

    // If no OB is found at all, we fake one just for this Telegram test
    if (!activeOB && analysis.orderBlocks.length > 0) {
      activeOB = analysis.orderBlocks[0];
    } else if (!activeOB) {
      activeOB = { high: currentPrice + 2, low: currentPrice - 2 };
    }

    // 4. Calculate Trade Parameters
    const isBuy = analysis.trend === "BULLISH";
    const entry = isBuy ? activeOB.high : activeOB.low;
    const atrBuffer = analysis.atr.value * 0.5;
    
    const stopLoss = isBuy ? activeOB.low - atrBuffer : activeOB.high + atrBuffer;
    const risk = Math.abs(entry - stopLoss);
    const takeProfit = isBuy ? entry + (risk * 2) : entry - (risk * 2); // 1:2 Risk/Reward

    // 5. AI News Check (FORCE TEST: We skip the AI completely so it doesn't block us)
    const aiDecision = { 
      recommendation: "APPROVE", 
      reason: "Test signal forced by developer to verify Telegram connection." 
    };

    // 6. Send to Telegram
    const message = `
🚨 **SKY AI TEST SIGNAL** 🚨
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

    if (!tgRes.ok) {
      const tgError = await tgRes.text();
      return "ERROR: Telegram send failed. Please check your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Cloudflare. Details: " + tgError;
    }

    return `SUCCESS! Signal sent to Telegram.\n\n${isBuy ? 'BUY' : 'SELL'} ${symbol} at ${entry.toFixed(5)}`;

  } catch (error) {
    return "CRITICAL ERROR: " + error.message;
  }
}
