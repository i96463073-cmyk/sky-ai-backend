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
    
    const oldAppStateStr = await env.SKY_MEMORY.get("app_state") || '{"pending":[],"completed":[],"news":[]}';
    const oldAppState = JSON.parse(oldAppStateStr);
    
    let pendingTrades = oldAppState.pending || [];
    let completedTrades = oldAppState.completed || [];
    let news = oldAppState.news || [];
    let watchlist = JSON.parse(await env.SKY_MEMORY.get("watchlist_trades") || "[]");
    let livePrices = {};
    
    const symbolsToScan = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF", "AUDUSD", "NZDUSD"];
    const timeframes = ["M15", "H1"];

    // 1. FETCH LIVE PRICES & WRITE TO CACHE
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

    const cache = caches.default;
    const cacheKey = new Request("https://sky-ai-backend.i96463073.workers.dev/api/prices-cache", { method: "GET" });
    const cacheResponse = new Response(JSON.stringify(livePrices), {
      headers: { "Content-Type": "application/json", "Cache-Control": "s-maxage=300" }
    });
    ctx.waitUntil(cache.put(cacheKey, cacheResponse));

    // 2. CHECK WATCHLIST
    let newWatchlist = [];
    for (const trade of watchlist) {
      const px = livePrices[trade.symbol];
      if (!px) { newWatchlist.push(trade); continue; }

      let isTriggered = false;
      let isInvalidated = false;

      if (trade.direction === "BUY") {
        if (px <= trade.entry) isTriggered = true;
        else if (px <= trade.stop_loss) isInvalidated = true;
      } else {
        if (px >= trade.entry) isTriggered = true;
        else if (px >= trade.stop_loss) isInvalidated = true;
      }

      if (isTriggered) {
        console.log(`🎯 Watchlist Triggered: ${trade.symbol} ${trade.timeframe}`);
        pendingTrades.push(trade); 
        
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
        newWatchlist.push(trade);
      }
    }
    watchlist = newWatchlist;

    // 3. MANAGE ACTIVE TRADES
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
            
            if (existingActive.some(t => t.timeframe === tf) || existingWatch.some(t => t.timeframe === tf)) continue;
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
              breakdown: res.signal.breakdown,
              confluence: res.signal.confluence || [],
              created_at: new Date().toISOString(),
              timeframe: tf,
              tp_hit: 0
            };

            watchlist.push(newTrade);
            console.log(`👀 Added to Watchlist: ${symbol} ${tf} | Waiting for entry at ${levels.entry}`);
          }
        } catch (e) {
          console.error(`Error scanning ${symbol} ${tf}:`, e);
        }
      }
    }

    completedTrades = completedTrades.slice(0, 50);
    watchlist = watchlist.slice(-20);

    // 🟢 5. DIRTY CHECK: ONLY WRITE IF DATA CHANGED
    const newAppState = { pending: activeTrades, completed: completedTrades, news: news };
    const newAppStateStr = JSON.stringify(newAppState);

    if (newAppStateStr !== oldAppStateStr) {
      await env.SKY_MEMORY.put("app_state", newAppStateStr);
    }

    const oldWatchlistStr = JSON.stringify(watchlist);
    const newWatchlistStr = JSON.stringify(watchlist);
    if (newWatchlistStr !== oldWatchlistStr) {
      await env.SKY_MEMORY.put("watchlist_trades", newWatchlistStr);
    }
  }
};
