import { handleApi } from "./api.js";
import { getSignal } from "./engine.js";
import { SYMBOLS } from "./market/symbols.js";

// 📨 Helper function to send messages to Telegram
async function sendTelegramMessage(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log("Telegram credentials missing. Skipping notification.");
    return;
  }

  const url = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: env.TELEGRAM_CHAT_ID,
        text: message,
        parse_mode: "HTML"
      })
    });
    if (!response.ok) console.error("Telegram Error:", await response.text());
  } catch (e) {
    console.error("Failed to send Telegram message:", e);
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }
    
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
    
    // We will scan these pairs and timeframes
    const symbolsToScan = ["XAUUSD", "EURUSD", "GBPUSD", "USDJPY", "USDCAD", "USDCHF", "AUDUSD", "NZDUSD"];
    const timeframes = ["M15", "H1"];

    for (const symbol of symbolsToScan) {
      for (const tf of timeframes) {
        try {
          const res = await getSignal(env, symbol, tf);
          
          // If a valid BUY or SELL is found (Score >= 40 from decision.js)
          if (res.ok && res.signal && (res.signal.decision === "BUY" || res.signal.decision === "SELL")) {
            
            // Check if we already have this active trade saved in the app
            const exists = pendingTrades.find(t => t.symbol === symbol && t.timeframe === tf);
            if (exists) continue;

            const levels = res.signal.levels;
            const isBuy = res.signal.decision === "BUY";

            // 1. Create the trade object for the App
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

            // 2. Save to Database for the App (All signals >= 40 go here)
            pendingTrades.push(newTrade);
            console.log(`✅ Saved to App DB: ${symbol} ${tf} | Score: ${newTrade.confidence}%`);

            // 3. Send to Telegram ONLY if Confidence >= 70%
            if (newTrade.confidence >= 70) {
              console.log(`📨 Sending high-quality signal to Telegram: ${symbol} ${tf} | Score: ${newTrade.confidence}%`);
              
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
-----------------------------------
<b>Confluence:</b>
${newTrade.confluence.map(c => `• ${c}`).join('\n')}
              `.trim();

              await sendTelegramMessage(env, tgMessage);
            } else {
              console.log(`🤫 Skipping Telegram for ${symbol} ${tf} (Score: ${newTrade.confidence}% is below 70%).`);
            }
          }
        } catch (e) {
          console.error(`Error scanning ${symbol} ${tf}:`, e);
        }
      }
    }

    // Save updated list to DB (Keep only the latest 30)
    pendingTrades = pendingTrades.slice(-30); 
    await env.SKY_MEMORY.put("pending_trades", JSON.stringify(pendingTrades));
    console.log(`Cron Job Finished. Active trades in app: ${pendingTrades.length}`);
  }
};
