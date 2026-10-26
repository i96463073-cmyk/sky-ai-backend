import { runAgent } from "./agent.js";
import { handleApi } from "./api.js";
import { runSignalEngine } from "./engine.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    // Route: /api/*
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // Route: /chat
    if (url.pathname === "/chat" && request.method === "POST") {
      const body = await request.json();
      const result = await runAgent(env, "user", body.message);
      return new Response(JSON.stringify(result), { 
        headers: { ...corsHeaders, "Content-Type": "application/json" } 
      });
    }

    // Route: /test-signal (Now prints result to screen)
    if (url.pathname === "/test-signal") {
      const resultText = await runSignalEngine(env, "XAUUSD", "M15");
      return new Response(resultText, { 
        headers: { ...corsHeaders, "Content-Type": "text/plain; charset=UTF-8" } 
      });
    }

    // Health Check
    return new Response(JSON.stringify({ status: "online", version: "1.0.0" }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" }
    });
  },

  // CRON TRIGGER (Runs automatically)
  async scheduled(event, env, ctx) {
    // This will run in the background without displaying to a screen
    ctx.waitUntil(runSignalEngine(env, "XAUUSD", "M15"));
  }
};
