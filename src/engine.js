// engine.js
// SKY AI SIGNALS — market data, SMC analysis, signal decisions,
// chart annotations, data-quality checks, duplicate protection,
// and optional Telegram delivery.

import { SYMBOLS, TIMEFRAMES } from "./market/symbols.js";
import {
  getMarketData,
  assessFreshness
} from "./market/biquote.js";
import { analyze } from "./smc/analyze.js";
import {
  evaluateSetup,
  buildChartAnnotations
} from "./smc/decision.js";

const ENGINE_VERSION = "2.0.0";
const CANDLE_LIMIT = 300;

// Conservative defaults. Configure these as Worker variables
// if you want to change the quality thresholds.
const MIN_CANDLES = 80;
const MAX_UNEXPECTED_GAPS = 2;
const DEDUPE_TTL_SECONDS = 60 * 60 * 24;

function json(data) {
  return JSON.stringify(data);
}

function response(status, message, extra = {}) {
  return json({
    ok: false,
    engineVersion: ENGINE_VERSION,
    status,
    message,
    ...extra
  });
}

function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function normalizeCandles(candles) {
  if (!Array.isArray(candles)) return [];

  return candles
    .filter(c =>
      c &&
      finiteNumber(c.time) &&
      finiteNumber(c.open) &&
      finiteNumber(c.high) &&
      finiteNumber(c.low) &&
      finiteNumber(c.close)
    )
    .slice()
    .sort((a, b) => a.time - b.time);
}

function getClosedCandles(candles) {
  return candles.filter(c => c.closed === true);
}

function candleSummary(candles) {
  if (!candles.length) return null;

  const c = candles[candles.length - 1];

  return {
    time: c.iso || new Date(c.time).toISOString(),
    timestamp: c.time,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    closed: c.closed === true
  };
}

function getUnexpectedGapCount(quality) {
  const gaps = quality?.unexpectedGaps;

  if (Array.isArray(gaps)) return gaps.length;
  if (typeof gaps === "number") return gaps;

  return 0;
}

function getDataQualityWarnings(quality) {
  const warnings = Array.isArray(quality?.warnings)
    ? quality.warnings
    : [];

  return warnings;
}

function buildSignalId(symbol, timeframe, setup, lastCandle) {
  const zoneKey =
    setup?.candidateZone?.orderBlockTime ??
    setup?.candidateZone?.top ??
    "no-zone";

  const entry = setup?.levels?.planned_entry ?? "no-entry";

  return [
    symbol,
    timeframe,
    setup?.direction ?? "NONE",
    zoneKey,
    entry,
    lastCandle?.time ?? "no-candle"
  ].join(":");
}

async function readKV(env, key) {
  if (!env.SKY_MEMORY) return null;

  try {
    return await env.SKY_MEMORY.get(key);
  } catch {
    return null;
  }
}

async function writeKV(env, key, value, options = {}) {
  if (!env.SKY_MEMORY) return false;

  try {
    await env.SKY_MEMORY.put(key, value, options);
    return true;
  } catch {
    return false;
  }
}

async function sendTelegram(env, text) {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = env.TELEGRAM_CHAT_ID;

  // Telegram is optional. Signal generation still works without it.
  if (!token || !chatId) {
    return {
      configured: false,
      sent: false,
      reason: "Telegram credentials are not configured."
    };
  }

  try {
    const result = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          chat_id: chatId,
          text,
          disable_web_page_preview: true
        })
      }
    );

    const data = await result.json();

    if (!result.ok || data.ok !== true) {
      return {
        configured: true,
        sent: false,
        reason: data.description || `Telegram HTTP ${result.status}`
      };
    }

    return {
      configured: true,
      sent: true
    };
  } catch (error) {
    return {
      configured: true,
      sent: false,
      reason: error?.message || "Telegram request failed."
    };
  }
}

function formatPrice(value) {
  if (!finiteNumber(value)) return "N/A";

  return value.toLocaleString("en-US", {
    maximumFractionDigits: 5
  });
}

function formatTelegramSignal(symbol, timeframe, setup, market, analysis) {
  const direction = setup.direction || "NO TRADE";
  const levels = setup.levels || {};

  const reasons = Array.isArray(setup.reasons)
    ? setup.reasons.slice(0, 6)
    : [];

  const lines = [
    `SKY AI SIGNALS`,
    `${symbol} | ${timeframe}`,
    `Decision: ${setup.decision}`,
    `Direction: ${direction}`,
    `Score: ${setup.score ?? "N/A"}/${setup.maxScore ?? "N/A"}`,
    `Confidence: ${setup.confidenceLabel ?? "N/A"}`,
    `Trend: ${analysis.trend ?? "N/A"}`,
    `Price: ${formatPrice(market.close)}`,
    `Entry: ${formatPrice(levels.planned_entry)}`,
    `Stop loss: ${formatPrice(levels.stop_loss)}`,
    `Take profit: ${formatPrice(levels.take_profit)}`,
    `Entry status: ${setup.entryStatus ?? "N/A"}`,
    "",
    "Reasons:",
    ...(reasons.length
      ? reasons.map(reason => `- ${String(reason)}`)
      : ["- See chart annotations and analysis."]),
    "",
    "Potential setup only — confirm conditions before trading."
  ];

  return lines.join("\n");
}

/**
 * Run the analysis for one symbol and timeframe.
 *
 * Returns a JSON string so the existing Worker route can return it directly.
 */
export async function runSignalEngine(env, symbolKey = "XAUUSD", tfKey = "M15") {
  const startedAt = Date.now();

  try {
    // 1. Validate symbol and timeframe.
    if (!SYMBOLS[symbolKey]) {
      return response(
        "INVALID_SYMBOL",
        `Unsupported symbol: ${symbolKey}`,
        { supportedSymbols: Object.keys(SYMBOLS) }
      );
    }

    if (!TIMEFRAMES[tfKey]) {
      return response(
        "INVALID_TIMEFRAME",
        `Unsupported timeframe: ${tfKey}`,
        { supportedTimeframes: Object.keys(TIMEFRAMES) }
      );
    }

    // 2. Fetch market data using the actual biquote.js signature:
    // getMarketData(env, symbolKey, tfKey, limit)
    const market = await getMarketData(
      env,
      symbolKey,
      tfKey,
      CANDLE_LIMIT
    );

    if (!market || market.ok !== true || !Array.isArray(market.candles)) {
      return response(
        "MARKET_DATA_ERROR",
        "The market-data provider did not return valid candles.",
        {
          symbol: symbolKey,
          timeframe: tfKey,
          provider: market?.provider ?? "unknown",
          providerResponse: market ?? null
        }
      );
    }

    const candles = normalizeCandles(market.candles);
    const closedCandles = getClosedCandles(candles);
    const quality = market.quality ?? {};

    if (closedCandles.length < MIN_CANDLES) {
      return response(
        "INSUFFICIENT_CANDLES",
        `Need at least ${MIN_CANDLES} closed candles for analysis.`,
        {
          symbol: symbolKey,
          timeframe: tfKey,
          receivedCandles: candles.length,
          closedCandles: closedCandles.length,
          marketQuality: quality
        }
      );
    }

    // 3. Freshness check. If the helper throws or returns an unknown shape,
    // do not silently assume that the market data is fresh.
    let freshness;

    try {
      freshness = assessFreshness(candles, tfKey, Date.now());
    } catch (error) {
      return response(
        "FRESHNESS_CHECK_ERROR",
        "Could not verify market-data freshness.",
        { error: error?.message || String(error) }
      );
    }

    // 4. Block data with clearly excessive gaps.
    const unexpectedGaps = getUnexpectedGapCount(quality);

    if (unexpectedGaps > MAX_UNEXPECTED_GAPS) {
      return response(
        "DATA_QUALITY_BLOCK",
        "Analysis stopped because the feed contains too many unexpected candle gaps.",
        {
          symbol: symbolKey,
          timeframe: tfKey,
          unexpectedGaps,
          marketQuality: quality,
          freshness
        }
      );
    }

    // The freshness helper's exact result shape can vary. Inspect its
    // returned fields conservatively and block only explicit stale/error
    // states, not a normal weekend market-closed state.
    const freshnessText = JSON.stringify(freshness ?? {}).toLowerCase();

    const explicitlyStale =
      freshness?.ok === false ||
      freshness?.stale === true ||
      freshness?.status === "stale" ||
      freshness?.state === "stale" ||
      freshnessText.includes('"status":"stale"') ||
      freshnessText.includes('"state":"stale"');

    if (explicitlyStale) {
      return response(
        "STALE_MARKET_DATA",
        "The latest market data is stale. No signal was generated.",
        {
          symbol: symbolKey,
          timeframe: tfKey,
          freshness,
          lastClosedCandle: candleSummary(closedCandles)
        }
      );
    }

    // 5. Run SMC analysis using closed candles only.
    const analysis = analyze(closedCandles, tfKey);

    if (!analysis || analysis.ok !== true) {
      return response(
        "ANALYSIS_FAILED",
        "The SMC analysis could not produce a valid analysis.",
        {
          symbol: symbolKey,
          timeframe: tfKey,
          analysis: analysis ?? null,
          marketQuality: quality
        }
      );
    }

    const latestCandle = closedCandles[closedCandles.length - 1];
    const currentPrice = latestCandle.close;

    // 6. Evaluate the setup.
    const setup = evaluateSetup(analysis, currentPrice);

    if (!setup || typeof setup !== "object") {
      return response(
        "DECISION_FAILED",
        "The setup evaluator returned no valid decision.",
        {
          symbol: symbolKey,
          timeframe: tfKey,
          currentPrice
        }
      );
    }

    // 7. Build chart annotations even when there is no trade setup.
    // The frontend can draw these over the corresponding candles.
    const annotations = buildChartAnnotations(analysis, setup);

    const result = {
      ok: true,
      engineVersion: ENGINE_VERSION,
      status: setup.decision === "NO_TRADE" ? "NO_TRADE" : "SETUP_FOUND",
      symbol: symbolKey,
      symbolName: SYMBOLS[symbolKey].name,
      timeframe: tfKey,
      provider: market.provider ?? "unknown",
      fetchedAt: market.fetchedAt ?? null,
      cached: market.cached ?? false,
      processingMs: Date.now() - startedAt,

      market: {
        candleCount: candles.length,
        closedCandleCount: closedCandles.length,
        latestClosedCandle: candleSummary(closedCandles),
        currentPrice,
        quality,
        freshness
      },

      analysis,
      setup,
      annotations: Array.isArray(annotations) ? annotations : [],
      signal: {
        decision: setup.decision ?? "NO_TRADE",
        direction: setup.direction ?? null,
        score: setup.score ?? null,
        maxScore: setup.maxScore ?? null,
        confidenceLabel: setup.confidenceLabel ?? null,
        reasons: Array.isArray(setup.reasons) ? setup.reasons : [],
        evidence: setup.evidence ?? [],
        candidateZone: setup.candidateZone ?? null,
        levels: setup.levels ?? null,
        entryStatus: setup.entryStatus ?? null
      }
    };

    // 8. Do not notify for NO_TRADE decisions.
    if (setup.decision === "NO_TRADE" || !setup.direction || !setup.levels) {
      return json(result);
    }

    // 9. Duplicate protection.
    const signalId = buildSignalId(
      symbolKey,
      tfKey,
      setup,
      latestCandle
    );

    const dedupeKey = `last_signal:${symbolKey}:${tfKey}`;
    const previousSignalId = await readKV(env, dedupeKey);

    if (previousSignalId === signalId) {
      result.notification = {
        sent: false,
        duplicate: true,
        reason: "This setup was already processed."
      };

      return json(result);
    }

    // 10. Store a pending setup for the frontend/backend to track.
    // This does NOT mean a position was opened or that entry was reached.
    const pendingKey = `pending_setup:${signalId}`;

    const pendingSetup = {
      signalId,
      symbol: symbolKey,
      timeframe: tfKey,
      direction: setup.direction,
      decision: setup.decision,
      score: setup.score,
      confidenceLabel: setup.confidenceLabel,
      candidateZone: setup.candidateZone ?? null,
      levels: setup.levels,
      entryStatus: setup.entryStatus ?? "WAITING_FOR_ENTRY",
      status: "WAITING_FOR_ENTRY",
      createdAt: new Date().toISOString(),
      lastClosedCandleTime: latestCandle.time
    };

    if (env.SKY_MEMORY) {
      const existingPending = await readKV(env, pendingKey);

      if (!existingPending) {
        await writeKV(env, pendingKey, JSON.stringify(pendingSetup), {
          expirationTtl: DEDUPE_TTL_SECONDS
        });
      }
    }

    // 11. Send Telegram if credentials are configured.
    // Only mark the signal as processed after notification succeeds,
    // or when Telegram is not configured.
    const telegramMessage = formatTelegramSignal(
      symbolKey,
      tfKey,
      setup,
      { close: currentPrice },
      analysis
    );

    const notification = await sendTelegram(env, telegramMessage);

    result.notification = notification;
    result.signalId = signalId;
    result.pendingSetup = pendingSetup;

    if (notification.sent || notification.configured === false) {
      await writeKV(
        env,
        dedupeKey,
        signalId,
        { expirationTtl: DEDUPE_TTL_SECONDS }
      );
    }

    return json(result);

  } catch (error) {
    return response(
      "ENGINE_ERROR",
      error?.message || "Unexpected signal-engine error.",
      {
        symbol: symbolKey,
        timeframe: tfKey,
        processingMs: Date.now() - startedAt
      }
    );
  }
}
