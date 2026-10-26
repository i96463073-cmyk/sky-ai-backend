import { getMarketData } from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";
import { runAgent } from "./agent.js";

export async function runSignalEngine(env, symbol = "XAUUSD", tfKey = "M15") {
  try {
    // 1. Fetch Data
    const data = await getMarketData(env, symbol, tfKey, 300);
    if (!data.ok) return "ERROR: Data fetch failed.";

    const currentPrice = Number(data.candles[data.candles.length - 1].close);

    // 2. CHECK PENDING TRADES (Win/Loss Logic)
    if (env.SKY_MEMORY) {
      let pendingTrades = JSON.parse(await env.SKY_MEMORY.get("pending_trades") || "[]");
      let completedTrades = JSON.parse(await env.SKY_MEMORY.get("completed_trades") || "[]");
      let stillPending = [];

      for (let trade of pendingTrades) {
        let isWin = false;
        let isLoss = false;

        // Check if price hit Take Profit or Stop Loss
        if (trade.direction === "BUY") {
          if (currentPrice >= trade.take_profit) isWin = true;
          else if (currentPrice <= trade.stop_loss) isLoss = true;
        } else if (trade.direction === "SELL") {
          if (currentPrice <= trade.take_profit) isWin = true;
          else if (currentPrice >= trade.stop_loss) isLoss = true;
        }

        if (isWin || isLoss) {
          trade.result = isWin ? "WIN" : "LOSS";
          trade.closed_at = new Date().toISOString();
          completedTrades.push(trade);
        } else {
          stillPending.push(trade);
        }
      }

      // Save updated lists back to database
      await env.SKY_MEMORY.put("pending_trades", JSON.stringify(stillPending));
      await env.SKY_MEMORY.put("completed_trades", JSON.stringify(completedTrades));
    }

    // 3. Run SMC Math to find NEW trades
    const analysis = analyze(data.candles, tfKey);
    if (!analysis.ok) return "ERROR: Analysis failed.";

    const activeOB = analysis.orderBlocks.find(ob => {
      const obHigh = ob.high || ob.top || currentPrice;
      const distance = Math.abs(currentPrice - obHigh) / currentPrice;
      return distance < 0.005; 
    });

    if (!activeOB) return `No active setup near ${currentPrice}.`;

    // 4. Calculate Trade Parameters
    const isBuy = analysis.trend === "BULLISH";
    const obHigh = Number(activeOB.high || activeOB.top || currentPrice);
    const obLow = Number(activeOB.low || activeOB.bottom || currentPrice);
    const atrBuffer = Number(analysis.atr?.value || 2) * 0.5;
    
    const entry = isBuy ? obHigh : obLow;
    const stopLoss = isBuy ? (obLow - atrBuffer) : (obHigh + atrBuffer);
    const risk = Math.abs(entry - stopLoss);
    const takeProfit = isBuy ? (entry + (risk * 2)) : (entry - (risk * 2)); 

    // 5. AI News Check
    const prompt = `I am about to take a ${isBuy ? 'BUY' : 'SELL'} on ${symbol}. Entry: ${entry.toFixed(5)}. Search news. Reply ONLY JSON: {"recommendation": "APPROVE" | "BLOCK", "reason": "..."}`;
    const aiResponse = await runAgent(env, "system", prompt);
    
    let aiDecision = { recommendation: "APPROVE", reason: "AI skipped or failed." };
    try {
      const match = aiResponse.reply.match(/\{[\s\S]*\}/);
      if (match) aiDecision = JSON.parse(match[0]);
    } catch (e) {}

    if (aiDecision.recommendation !== "APPROVE") {
      return `Trade BLOCKED by AI: ${aiDecision.reason}`;
    }

    // 6. Save NEW trade to Database
    const newTrade = {
      id: Date.now().toString(),
      symbol: symbol,
      direction: isBuy ? "BUY" : "SELL",
      entry: Number(entry.toFixed(5)),
      stop_loss: Number(stopLoss.toFixed(5)),
      take_profit: Number(takeProfit.toFixed(5)),
      created_at: new Date().toISOString(),
      result: null
    };

    if (env.SKY_MEMORY) {
      let pendingTrades = JSON.parse(await env.SKY_MEMORY.get("pending_trades") || "[]");
      pendingTrades.push(newTrade);
      await env.SKY_MEMORY.put("pending_trades", JSON.stringify(pendingTrades));
    }

    // 7. Send to Telegram
    const message = `🚨 **NEW SIGNAL** 🚨\nPair: ${symbol}\nDirection: **${newTrade.direction}**\nEntry: ${newTrade.entry}\nSL: ${newTrade.stop_loss}\nTP: ${newTrade.take_profit}`;
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: "Markdown" })
    });

    return "SUCCESS! Signal generated and saved.";
  } catch (error) {
    return "ERROR: " + error.message;
  }
}
