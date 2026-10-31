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
    console.log("Cron Job Started: Managing trades, watchlist, and scanning...");
    
    let pendingTrades = JSON.parse(await env.SKY_MEMORY.get("pending_trades") || "[]");
    let watchlist = JSON.parse(await env.SKY_MEMORY.get("watchlist_trades") || "[]");
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

    // 2. CHECK WATCHLIST FOR ENTRY TRIGGERS
    let newWatchlist = [];
    for (const trade of watchlist) {
      const px = livePrices[trade.symbol];
      if (!px) { newWatchlist.push(trade); continue; }

      let isTriggered = false;
      let isInvalidated = false;

      if (trade.direction === "BUY") {
        if (px <= trade.entry) isTriggered = true; // Price dropped to entry
        else if (px <= trade.stop_loss) isInvalidated = true; // Price hit SL before entry
      } else {
        if (px >= trade.entry) isTriggered = true; // Price rose to entry
        else if (px >= trade.stop_loss) isInvalidated = true; // Price hit SL before entry
      }

      if (isTriggered) {
        console.log(`🎯 Watchlist Triggered: ${trade.symbol} ${trade.timeframe}`);
        pendingTrades.push(trade); // Move to active app trades
        
        // Send Telegram Alert NOW that entry is hit
        if (trade.confidence >= 60) {
          let emoji = trade.quality === "HIGH" ? "🔥" : "⚡";
          await sendTelegramMessage(env, `
${emoji} <b>SKY AI ${trade.quality} ENTRY TRIGGERED (${trade.confidence}%)</b> ${emoji}
<b>Pair:</b> ${trade.symbol} (${trade.timeframe})
<b>Direction:</b> ${trade.direction === "BUY" ? "🟢 BUY" : "🔴 SELL"}
-----------------------------------
<b>Entry:</b> ${trade.entry.toFixed(5)}
<b>Stop Loss:</b> ${trade.stop_loss.toFixed(5)}
<b>TP1:</b> ${trade.take_profit[0].toFixed(5)}
          `.trim());
        }
      } else if (!isInvalidated) {
        newWatchlist.push(trade); // Keep waiting
      } else {
        console.log(`🗑️ Watchlist Invalidated (Hit SL before Entry): ${trade.symbol} ${trade.timeframe}`);
      }
    }
    watchlist = newWatchlist;

    // 3. MANAGE ACTIVE TRADES (TP/SL)
    let activeTrades = [];
    for (const trade of pendingTrades) {
      const px = livePrices[trade.symbol];
      if (!px) { activeTrades.push(trade); continue; }

      if (!trade.tp_hit) trade.tp_hit = 0;
      
      const sl = trade.stop_loss;
      const tps = trade.take_profit;
      const lastTp = tps[tps.length - 1]; 
      
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
        if (px >= lastTp) { isClosed = true; result = "WIN"; exitPrice = lastTp; }
        else if (px <= sl) {
          isClosed = true;
          if (trade.tp_hit > 0) { result = "WIN"; exitPrice = tps[trade.tp_hit - 1]; }
          else { result = "LOSS"; exitPrice = sl; }
        }
      } else if (trade.direction === "SELL") {
        if (px <= lastTp) { isClosed = true; result = "WIN"; exitPrice = lastTp; }
        else if (px >= sl) {
          isClosed = true;
          if (trade.tp_hit > 0) { result = "WIN"; exitPrice = tps[trade.tp_hit - 1]; }
          else { result = "LOSS"; exitPrice = sl; }
        }
      }

      if (isClosed) {
        trade.result = result;
        trade.closed_at = new Date().toISOString();
        trade.exit_price = exitPrice;
        completedTrades.unshift(trade);
      } else {
        activeTrades.push(trade);
      }
    }

    // 4. SCAN FOR NEW SIGNALS
    for (const symbol of symbolsToScan) {
      for (const tf of timeframes) {
        try {
          const res = await getSignal(env, symbol, tf);
          
          if (res.ok && res.signal && (res.signal.decision === "BUY" || res.signal.decision === "SELL")) {
            
            const existingActive = activeTrades.filter(t => t.symbol === symbol);
            const existingWatch = watchlist.filter(t => t.symbol === symbol);
            
            // Skip exact match
            if (existingActive.some(t => t.timeframe === tf) || existingWatch.some(t => t.timeframe === tf)) continue;

            // Skip if active on other TF and not high quality
            if ((existingActive.length > 0 || existingWatch.length > 0) && res.signal.confidence < 80) continue;

            const levels = res.signal.levels;

            const newTrade = {
              id: "sig_" + Date.now() + "_" + Math.floor(Math.random()*1000),
              symbol: symbol,
              direction: res.signal.decision,
              entry: levels.entry,
              stop_loss: levels.stop_loss,
              take_profit: levels.take_profit, 
              confidence: res.signal.confidence, 
              quality: res.signal.quality,
              confluence: res.signal.confluence || [],
              created_at: new Date().toISOString(),
              timeframe: tf,
              tp_hit: 0
            };

            // Add to Watchlist (Do NOT send to app yet)
            watchlist.push(newTrade);
            console.log(`👀 Added to Watchlist: ${symbol} ${tf} | Waiting for entry at ${levels.entry}`);
            
          }
        } catch (e) {
          console.error(`Error scanning ${symbol} ${tf}:`, e);
        }
      }
    }

    // Keep DB clean
    completedTrades = completedTrades.slice(0, 50);
    watchlist = watchlist.slice(-20);

    await env.SKY_MEMORY.put("pending_trades", JSON.stringify(activeTrades));
    await env.SKY_MEMORY.put("watchlist_trades", JSON.stringify(watchlist));
    await env.SKY_MEMORY.put("completed_trades", JSON.stringify(completedTrades));
    await env.SKY_MEMORY.put("live_prices", JSON.stringify(livePrices));
    
    console.log(`Job Done. Active: ${activeTrades.length}, Watchlist: ${watchlist.length}`);
  }
};
