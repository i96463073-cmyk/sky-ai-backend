import { handleApi } from "./api.js";
import { getSignal } from "./engine.js";
import { getMarketData } from "./market/biquote.js";

async function sendTelegramMessage(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message, parse_mode: "HTML" })
    });
  } catch (e) {
    console.error("Failed to send Telegram message:", e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) return handleApi(request, env);
    if (url.pathname === "/test-signal") {
      const symbol = url.searchParams.get("symbol") || "XAUUSD";
      const timeframe = url.searchParams.get("timeframe") || "M15";
      const result = await getSignal(env, symbol, timeframe);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }
    return new Response("Sky AI Backend is running.", { status: 200 });
  },

  async scheduled(event, env, ctx) {
    console.log("Cron Job Started: Managing trades and scanning...");
    
    let pendingTrades = JSON.parse(await env.SKY_MEMORY.get("pending_trades") || "[]");
    let completedTrades = JSON.parse(await env.SKY_MEMORY.get("completed_trades") || "[]");
    let livePrices = JSON.parse(await env.SKY_MEMORY.get("live_prices") || "{}");
    
    const symbolsToScan = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF", "AUDUSD", "NZDUSD"];
    const timeframes = ["M15", "H1"];

    // 1. FETCH LIVE PRICES
    for (const symbol of symbolsToScan) {
      try {
        const marketData = await getMarketData(env, symbol, "M15", 1);
        if (marketData && marketData.ok && marketData.candles && marketData.candles.length > 0) {
          livePrices[symbol] = marketData.candles[marketData.candles.length - 1].close;
        }
      } catch (e) {
        console.error(`Error fetching price for ${symbol}:`, e);
      }
    }

    // 2. CHECK ACTIVE TRADES FOR SL/TP HITS
    let activeTrades = [];
    
    for (const trade of pendingTrades) {
      const px = livePrices[trade.symbol];
      if (!px) {
        activeTrades.push(trade); 
        continue; 
      }

      if (!trade.tp_hit) trade.tp_hit = 0;
      
      const sl = trade.stop_loss;
      const tps = trade.take_profit;
      const lastTp = tps[tps.length - 1]; // TP3
      
      // Update highest TP hit
      if (trade.direction === "BUY") {
        if (tps[0] && px >= tps[0]) trade.tp_hit = Math.max(trade.tp_hit, 1);
        if (tps[1] && px >= tps[1]) trade.tp_hit = Math.max(trade.tp_hit, 2);
        if (tps[2] && px >= tps[2]) trade.tp_hit = Math.max(trade.tp_hit, 3);
      } else {
        if (tps[0] && px <= tps[0]) trade.tp_hit = Math.max(trade.tp_hit, 1);
        if (tps[1] && px <= tps[1]) trade.tp_hit = Math.max(trade.tp_hit, 2);
        if (tps[2] && px <= tps[2]) trade.tp_hit = Math.max(trade.tp_hit, 3);
      }

      let isClosed = false;
      let result = "PENDING";
      let exitPrice = px;

      if (trade.direction === "BUY") {
        if (px >= lastTp) {
          isClosed = true;
          result = "WIN";
          exitPrice = lastTp;
        } else if (px <= sl) {
          isClosed = true;
          if (trade.tp_hit > 0) {
            result = "WIN"; // Locked in partial profit
            exitPrice = tps[trade.tp_hit - 1]; // Record the highest TP hit
          } else {
            result = "LOSS";
            exitPrice = sl;
          }
        }
      } else if (trade.direction === "SELL") {
        if (px <= lastTp) {
          isClosed = true;
          result = "WIN";
          exitPrice = lastTp;
        } else if (px >= sl) {
          isClosed = true;
          if (trade.tp_hit > 0) {
            result = "WIN"; // Locked in partial profit
            exitPrice = tps[trade.tp_hit - 1];
          } else {
            result = "LOSS";
            exitPrice = sl;
          }
        }
      }

      if (isClosed) {
        console.log(`❌ Trade Closed: ${trade.symbol} | Result: ${result} | TP Hit: ${trade.tp_hit}`);
        trade.result = result;
        trade.closed_at = new Date().toISOString();
        trade.exit_price = exitPrice;
        completedTrades.unshift(trade);
      } else {
        activeTrades.push(trade);
      }
    }

    // 3. SCAN FOR NEW SIGNALS
    for (const symbol of symbolsToScan) {
      for (const tf of timeframes) {
        try {
          const res = await getSignal(env, symbol, tf);
          
          if (res.ok && res.signal && (res.signal.decision === "BUY" || res.signal.decision === "SELL")) {
            const exists = activeTrades.find(t => t.symbol === symbol && t.timeframe === tf);
            if (exists) continue;

            const levels = res.signal.levels;
            const isBuy = res.signal.decision === "BUY";

            const newTrade = {
              id: "sig_" + Date.now() + "_" + Math.floor(Math.random()*1000),
              symbol: symbol,
              direction: res.signal.decision,
              entry: levels.entry,
              stop_loss: levels.stop_loss,
              take_profit: levels.take_profit, 
              confidence: res.signal.confidence || 0, 
              quality: res.signal.quality || "C",
              confluence: res.signal.confluence || [],
              created_at: new Date().toISOString(),
              timeframe: tf,
              tp_hit: 0 // Initialize
            };

            activeTrades.push(newTrade);
            console.log(`✅ New Setup: ${symbol} ${tf} | Score: ${newTrade.confidence}%`);

            if (newTrade.confidence >= 70) {
              const tgMessage = `
🚨 <b>SKY AI SIGNAL (${newTrade.confidence}%)</b> 🚨
<b>Pair:</b> ${symbol} (${tf})
<b>Direction:</b> ${isBuy ? "🟢 BUY" : "🔴 SELL"}
<b>Quality:</b> ${newTrade.quality}
-----------------------------------
<b>Entry:</b> ${levels.entry.toFixed(5)}
<b>Stop Loss:</b> ${levels.stop_loss.toFixed(5)}
<b>TP1:</b> ${levels.take_profit[0].toFixed(5)}
<b>TP3:</b> ${levels.take_profit[2].toFixed(5)}
              `.trim();
              await sendTelegramMessage(env, tgMessage);
            }
          }
        } catch (e) {
          console.error(`Error scanning ${symbol} ${tf}:`, e);
        }
      }
    }

    completedTrades = completedTrades.slice(0, 50);

    await env.SKY_MEMORY.put("pending_trades", JSON.stringify(activeTrades));
    await env.SKY_MEMORY.put("completed_trades", JSON.stringify(completedTrades));
    await env.SKY_MEMORY.put("live_prices", JSON.stringify(livePrices));
  }
};
