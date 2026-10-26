import { runAgent } from "./agent.js";
import { handleApi } from "./api.js";
import { runSignalEngine } from "./engine.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. CORS Headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // 2. Route: /api/* (Your existing Read-Only API)
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // 3. Route: /chat (Legacy Chat)
    if (url.pathname === "/chat" && request.method === "POST") {
      const body = await request.json();
      const result = await runAgent(env, "user", body.message);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // 4. Route: /test-signal (Manual trigger for testing)
    if (url.pathname === "/test-signal") {
      // Run synchronously for testing so you can see the result
      await runSignalEngine(env, "XAUUSD", "M15");
      return new Response("Signal engine triggered. Check console/Telegram.", { 
        headers: { ...corsHeaders, "Content-Type": "text/plain" } 
      });
    }

    // 5. Default: Health Check
    return new Response(JSON.stringify({ status: "online", version: "1.0.0" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  },

  // ============================================
  // CRON TRIGGER (Runs automatically based on wrangler.toml)
  // ============================================
  async scheduled(event, env, ctx) {
    // This runs every 15 minutes (e.g., XAUUSD on the 15m timeframe)
    ctx.waitUntil(runSignalEngine(env, "XAUUSD", "M15"));
    
    // You can add more pairs here to check simultaneously:
    // ctx.waitUntil(runSignalEngine(env, "EURUSD", "M15"));
  }
};
