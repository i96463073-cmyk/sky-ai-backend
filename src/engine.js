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

    const currentPrice = Number(analysis.lastClosedCandle.close);
    
    // 3. Find Active Order Block (FORCE TEST)
    let activeOB = analysis.orderBlocks.find(ob => {
      // Using safe property check (handles high/low or top/bottom)
      const obHigh = ob.high || ob.top || currentPrice;
      const distance = Math.abs(currentPrice - obHigh) / currentPrice;
      return distance < 0.5; 
    });

    if (!activeOB && analysis.orderBlocks.length > 0) {
      activeOB = analysis.orderBlocks[0];
    } else if (!activeOB) {
      activeOB = { high: currentPrice + 2, low: currentPrice - 2 };
    }

    // 4. Calculate Trade Parameters (with SAFE fallbacks so it never crashes)
    const isBuy = analysis.trend === "BULLISH";
    
    // Safely grab the high and low, defaulting to current price if missing
    const obHigh = Number(activeOB.high || activeOB.top || currentPrice);
    const obLow = Number(activeOB.low || activeOB.bottom || currentPrice);
    const atrBuffer = Number(analysis.atr?.value || 2) * 0.5; // default to 2 if ATR missing
    
    const entry = isBuy ? obHigh : obLow;
    const stopLoss = isBuy ? (obLow - atrBuffer) : (obHigh + atrBuffer);
    const risk = Math.abs(entry - stopLoss);
    const takeProfit = isBuy ? (entry + (risk * 2)) : (entry - (risk * 2)); 

    // Ensure all variables are valid numbers before formatting
    const safeEntry = Number(entry) || currentPrice;
    const safeSL = Number(stopLoss) || (currentPrice - 5);
    const safeTP = Number(takeProfit) || (currentPrice + 10);

    // 5. AI News Check (FORCE TEST: Bypassed)
    const aiDecision = { 
      recommendation: "APPROVE", 
      reason: "Test signal forced by developer to verify Telegram connection." 
    };

    // 6. Send to Telegram
    const message = `
🚨 **SKY AI TEST SIGNAL** 🚨
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
      return "ERROR: Telegram send failed. Please check your TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in Cloudflare. Details: " + tgError;
    }

    return `SUCCESS! Signal sent to Telegram.\n\n${isBuy ? 'BUY' : 'SELL'} ${symbol} at ${safeEntry.toFixed(5)}`;

  } catch (error) {
    return "CRITICAL ERROR: " + error.message;
  }
}
