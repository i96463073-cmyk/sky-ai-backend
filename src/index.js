import { handleApi } from "./api.js";
import { getSignal } from "./engine.js";
import { getMarketData } from "./market/biquote.js";

// 📨 Helper function to send messages to Telegram
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
    console.log("Cron Job Started: Scanning pairs...");
    
    let pendingTrades = JSON.parse(await env.SKY_MEMORY.get("pending_trades") || "[]");
    let livePrices = JSON.parse(await env.SKY_MEMORY.get("live_prices") || "{}");
    
    const symbolsToScan = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF", "AUDUSD", "NZDUSD"];
    const timeframes = ["M15", "H1"];

    for (const symbol of symbolsToScan) {
      
      // 🟢 1. FETCH LIVE PRICES FOR THE TICKER & PIPS
      try {
        const marketData = await getMarketData(env, symbol, "M15", 1);
        if (marketData && marketData.ok && marketData.candles && marketData.candles.length > 0) {
          livePrices[symbol] = marketData.candles[marketData.candles.length - 1].close;
        }
      } catch (e) {
        console.error(`Error fetching price for ${symbol}:`, e);
      }

      // 🔍 2. SCAN FOR SIGNALS
      for (const tf of timeframes) {
        try {
          const res = await getSignal(env, symbol, tf);
          
          if (res.ok && res.signal && (res.signal.decision === "BUY" || res.signal.decision === "SELL")) {
            const exists = pendingTrades.find(t => t.symbol === symbol && t.timeframe === tf);
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
              timeframe: tf
            };

            pendingTrades.push(newTrade);
            console.log(`✅ Found: ${symbol} ${tf} | Score: ${newTrade.confidence}%`);

            // 3. Send to Telegram ONLY if >= 70%
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
<b>TP2:</b> ${levels.take_profit[1].toFixed(5)}
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

    // Keep DB clean
    pendingTrades = pendingTrades.slice(-30); 
    
    // Save BOTH signals and live prices to the database
    await env.SKY_MEMORY.put("pending_trades", JSON.stringify(pendingTrades));
    await env.SKY_MEMORY.put("live_prices", JSON.stringify(livePrices));
    
    console.log(`Cron Job Finished. Active trades: ${pendingTrades.length}, Prices updated: ${Object.keys(livePrices).length}`);
  }
};
