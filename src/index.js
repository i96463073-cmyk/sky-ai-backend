import { handleApi } from "./api.js";
import { getSignal } from "./engine.js";
import { SYMBOLS } from "./market/symbols.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    // Handle API requests for the Android App
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    
    // Handle specific test routes
    if (url.pathname === "/test-signal") {
      const symbol = url.searchParams.get("symbol") || "XAUUSD";
      const timeframe = url.searchParams.get("timeframe") || "M15";
      const result = await getSignal(env, symbol, timeframe);
      return new Response(JSON.stringify(result), { headers: { "Content-Type": "application/json" } });
    }

    return new Response("Sky AI Backend is running.", { status: 200 });
  },

  // 🕒 CRON JOB: This runs automatically every 5 minutes
  async scheduled(event, env, ctx) {
    console.log("Cron Job Started: Scanning all pairs for setups...");
    
    // 1. Fetch current pending trades from Database
    let pendingTrades = JSON.parse(await env.SKY_MEMORY.get("pending_trades") || "[]");
    const completedTrades = JSON.parse(await env.SKY_MEMORY.get("completed_trades") || "[]");
    const livePrices = JSON.parse(await env.SKY_MEMORY.get("live_prices") || "{}");

    // 2. Loop through ALL supported symbols
    for (const symbol of Object.keys(SYMBOLS)) {
      const timeframes = ["M5", "M15", "H1"]; // Scans multiple timeframes

      for (const tf of timeframes) {
        try {
          // Fetch the signal for this pair
          const res = await getSignal(env, symbol, tf);
          
          if (res.ok && res.signal && (res.signal.decision === "BUY" || res.signal.decision === "SELL")) {
            
            // Check if we already have this active trade saved to avoid duplicates
            const exists = pendingTrades.find(t => t.symbol === symbol && t.timeframe === tf);
            if (exists) continue;

            // 🟢 CREATE THE SIGNAL FOR THE APP
            const newTrade = {
              id: "sig_" + Date.now() + "_" + Math.floor(Math.random()*1000),
              symbol: symbol,
              direction: res.signal.decision,
              entry: res.signal.levels.entry,
              stop_loss: res.signal.levels.stop_loss,
              take_profit: res.signal.levels.take_profit, // Array of TPs
              confidence: res.signal.confidence,
              quality: res.signal.quality,
              confluence: res.signal.confluence || [],
              created_at: new Date().toISOString(),
              timeframe: tf
            };

            // Add to pending list
            pendingTrades.push(newTrade);
            console.log(`✅ Found new signal: ${symbol} ${tf} ${newTrade.direction}`);
          }
        } catch (e) {
          console.error(`Error scanning ${symbol} ${tf}:`, e);
        }
      }
    }

    // 3. Update live prices in DB (Optional: fetch from your biquote provider if needed)
    // If you have a function to get live prices, save them to `livePrices` here.

    // 4. Save back to Database (Keep only last 30 trades to prevent DB overflow)
    pendingTrades = pendingTrades.slice(-30); 
    
    await env.SKY_MEMORY.put("pending_trades", JSON.stringify(pendingTrades));
    await env.SKY_MEMORY.put("live_prices", JSON.stringify(livePrices));
    
    console.log(`Cron Job Finished. Saved ${pendingTrades.length} pending trades.`);
  }
};
