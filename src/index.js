import { runAgent } from "./agent.js";
import { handleApi } from "./api.js";
import { runSignalEngine } from "./engine.js";
import { SYMBOLS } from "./market/symbols.js";

const DEFAULT_TIMEFRAME = "M15";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    const jsonResponse = (data, status = 200) =>
      new Response(
        typeof data === "string" ? data : JSON.stringify(data),
        {
          status,
          headers: {
            ...corsHeaders,
            "Content-Type": "application/json; charset=UTF-8",
          },
        }
      );

    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: corsHeaders,
      });
    }

    // Existing API routes.
    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env);
    }

    // Existing AI chat route.
    if (url.pathname === "/chat" && request.method === "POST") {
      try {
        const body = await request.json();

        if (!body || typeof body.message !== "string") {
          return jsonResponse(
            { ok: false, error: "A message is required." },
            400
          );
        }

        const result = await runAgent(env, "user", body.message);
        return jsonResponse(result);
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            error: error?.message || "Chat request failed.",
          },
          500
        );
      }
    }

    // Test a selected pair and timeframe.
    // Example: /test-signal?symbol=EURUSD&timeframe=M15
    if (url.pathname === "/test-signal" && request.method === "GET") {
      const symbol = (
        url.searchParams.get("symbol") || "XAUUSD"
      ).toUpperCase();

      const timeframe = (
        url.searchParams.get("timeframe") || DEFAULT_TIMEFRAME
      ).toUpperCase();

      if (!SYMBOLS[symbol]) {
        return jsonResponse(
          {
            ok: false,
            error: "Unsupported symbol.",
            supportedSymbols: Object.keys(SYMBOLS),
          },
          400
        );
      }

      try {
        const result = await runSignalEngine(
          env,
          symbol,
          timeframe
        );

        return jsonResponse(result);
      } catch (error) {
        return jsonResponse(
          {
            ok: false,
            symbol,
            timeframe,
            error: error?.message || "Signal check failed.",
          },
          500
        );
      }
    }

    // Health check.
    if (url.pathname === "/" || url.pathname === "/health") {
      return jsonResponse({
        status: "online",
        service: "SKY AI SIGNALS",
        supportedSymbols: Object.keys(SYMBOLS),
        defaultTimeframe: DEFAULT_TIMEFRAME,
      });
    }

    return jsonResponse(
      { ok: false, error: "Route not found." },
      404
    );
  },

  // Scheduled signal checks for all supported pairs.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        const symbols = Object.keys(SYMBOLS);

        // Run sequentially to avoid sending all provider requests
        // simultaneously.
        for (const symbol of symbols) {
          try {
            await runSignalEngine(
              env,
              symbol,
              DEFAULT_TIMEFRAME
            );
          } catch (error) {
            console.error(
              `Signal check failed for ${symbol}:`,
              error?.message || error
            );
          }
        }
      })()
    );
  },
};
