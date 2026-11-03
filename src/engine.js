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

const ENGINE_VERSION = "2.2.0";
const DEFAULT_CANDLE_LIMIT = 300;
const MIN_CLOSED_CANDLES = 30;
const HTF_CANDLE_LIMIT = 200;

// Higher timeframe used to confirm the trend of each timeframe.
// Timeframes not listed here get no signals (fail closed).
const HTF_MAP = {
  M5: "H1",
  M15: "H1",
  M30: "H4",
  H1: "H4"
};

function jsonSafe(value) {
  if (value === undefined) return null;
  try {
    return JSON.parse(JSON.stringify(value, (_key, item) => {
      if (typeof item === "number" && !Number.isFinite(item)) {
        return null;
      }
      return item;
    }));
  } catch {
    return null;
  }
}

function getClosedCandles(candles) {
  if (!Array.isArray(candles)) return [];

  return candles
    .filter(c => c && c.closed === true)
    .filter(c =>
      Number.isFinite(Number(c.time)) &&
      Number.isFinite(Number(c.open)) &&
      Number.isFinite(Number(c.high)) &&
      Number.isFinite(Number(c.low)) &&
      Number.isFinite(Number(c.close))
    )
    .filter(c => {
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);

      return (
        high >= Math.max(open, close, low) &&
        low <= Math.min(open, close, high) &&
        low > 0
      );
    })
    .sort((a, b) => Number(a.time) - Number(b.time));
}

function summarizeCandle(candle) {
  if (!candle) return null;
  return {
    time: Math.floor(Number(candle.time) / 1000),
    iso: candle.iso || new Date(Number(candle.time)).toISOString(),
    open: Number(candle.open),
    high: Number(candle.high),
    low: Number(candle.low),
    close: Number(candle.close),
    volume: Number(candle.tickVolume ?? candle.volume ?? 0)
  };
}

function summarizeCandles(candles) {
  return candles.map(summarizeCandle);
}

function getQuality(market, closedCandles) {
  const source = market.quality || {};
  return {
    received: Number(source.received ?? market.candles?.length ?? 0),
    accepted: Number(source.accepted ?? closedCandles.length),
    closedAccepted: closedCandles.length,
    rejectedCount: Number(source.rejectedCount ?? 0),
    rejected: jsonSafe(source.rejected ?? []),
    duplicatesRemoved: Number(source.duplicatesRemoved ?? 0),
    gaps: jsonSafe(source.gaps ?? []),
    unexpectedGaps: jsonSafe(source.unexpectedGaps ?? []),
    warnings: jsonSafe(source.warnings ?? [])
  };
}

function buildErrorResult({
  symbol,
  timeframe,
  message,
  startedAt,
  extra = {}
}) {
  return {
    ok: false,
    engineVersion: ENGINE_VERSION,
    status: "DATA_ERROR",
    symbol,
    timeframe,
    error: message,
    processingMs: Date.now() - startedAt,
    ...extra
  };
}

/**
 * Fetch the higher timeframe and return its trend.
 * Never throws: on any problem it returns trend = null and an error message,
 * and the decision engine then rejects the setup.
 */
async function loadHtfTrend(env, symbolKey, tfKey) {
  const htfKey = HTF_MAP[tfKey] ?? null;
  if (!htfKey || !TIMEFRAMES[htfKey]) {
    return { timeframe: htfKey, trend: null, error: `No usable higher timeframe for ${tfKey}.` };
  }
  try {
    const htfMarket = await getMarketData(env, symbolKey, htfKey, HTF_CANDLE_LIMIT);
    if (!htfMarket || htfMarket.ok !== true) {
      return { timeframe: htfKey, trend: null, error: htfMarket?.error || `${htfKey} data unavailable.` };
    }
    const htfClosed = getClosedCandles(htfMarket.candles);
    if (htfClosed.length < MIN_CLOSED_CANDLES) {
      return { timeframe: htfKey, trend: null, error: `Not enough ${htfKey} candles.` };
    }
    const htfAnalysis = analyze(htfClosed, htfKey);
    if (!htfAnalysis || htfAnalysis.ok !== true) {
      return { timeframe: htfKey, trend: null, error: `${htfKey} analysis failed.` };
    }
    return {
      timeframe: htfKey,
      trend: String(htfAnalysis.trend ?? "").toLowerCase() || null,
      error: null
    };
  } catch (error) {
    return { timeframe: htfKey, trend: null, error: error?.message || `${htfKey} fetch failed.` };
  }
}

/**
 * Run the complete market-data + SMC + setup evaluation pipeline.
 */
export async function getSignal(
  env,
  symbolKey = "XAUUSD",
  tfKey = "M15",
  options = {}
) {
  const startedAt = Date.now();

  // Gold on 15m is banned (excessive volatility)
  if (symbolKey === "XAUUSD" && tfKey === "M15") {
    return {
      ok: false,
      engineVersion: ENGINE_VERSION,
      status: "SKIPPED",
      symbol: symbolKey,
      timeframe: tfKey,
      signal: {
        decision: "NO_TRADE",
        direction: null,
        score: 0,
        reasons: ["XAUUSD (Gold) on 15m timeframe is banned due to excessive volatility."]
      }
    };
  }

  if (!SYMBOLS[symbolKey]) {
    return buildErrorResult({
      symbol: symbolKey,
      timeframe: tfKey,
      message: `Unsupported symbol: ${symbolKey}`,
      startedAt
    });
  }

  if (!TIMEFRAMES[tfKey]) {
    return buildErrorResult({
      symbol: symbolKey,
      timeframe: tfKey,
      message: `Unsupported timeframe: ${tfKey}`,
      startedAt
    });
  }

  const requestedLimit = Number(options.limit);
  const candleLimit = Number.isInteger(requestedLimit)
    ? Math.max(50, Math.min(requestedLimit, 500))
    : DEFAULT_CANDLE_LIMIT;

  try {
    // 1. Fetch market data
    const market = await getMarketData(env, symbolKey, tfKey, candleLimit);

    if (!market || market.ok !== true) {
      return buildErrorResult({
        symbol: symbolKey,
        timeframe: tfKey,
        message: market?.error || "Market data provider returned no valid data.",
        startedAt,
        extra: { provider: market?.provider ?? "unknown" }
      });
    }

    // 2. Use only completed candles
    const closedCandles = getClosedCandles(market.candles);
    const quality = getQuality(market, closedCandles);
    const freshness = assessFreshness(closedCandles, tfKey, Date.now());
    const chartCandles = summarizeCandles(closedCandles);

    const marketSummary = {
      provider: market.provider ?? "unknown",
      symbol: symbolKey,
      timeframe: tfKey,
      interval: market.interval ?? TIMEFRAMES[tfKey].interval,
      fetchedAt: market.fetchedAt ?? new Date().toISOString(),
      cached: Boolean(market.cached),
      candleCount: Array.isArray(market.candles) ? market.candles.length : 0,
      closedCandleCount: closedCandles.length,
      latestClosedCandle: chartCandles.length ? chartCandles[chartCandles.length - 1] : null,
      currentPrice: chartCandles.length ? chartCandles[chartCandles.length - 1].close : null,
      candles: chartCandles,
      quality,
      freshness
    };

    // 3. Check for sufficient data
    if (closedCandles.length < MIN_CLOSED_CANDLES) {
      return {
        ok: false,
        engineVersion: ENGINE_VERSION,
        status: "INSUFFICIENT_DATA",
        symbol: symbolKey,
        symbolName: SYMBOLS[symbolKey].name,
        timeframe: tfKey,
        market: marketSummary,
        signal: {
          decision: "NO_TRADE",
          direction: null,
          watch: false,
          score: 0,
          maxScore: null,
          confidenceLabel: "INSUFFICIENT_DATA",
          reasons: [
            `Only ${closedCandles.length} valid closed candles are available.`,
            `At least ${MIN_CLOSED_CANDLES} are required by this engine wrapper.`
          ],
          evidence: [],
          candidateZone: null,
          levels: null,
          entryStatus: "NOT_EVALUATED"
        },
        analysis: null,
        annotations: [],
        processingMs: Date.now() - startedAt
      };
    }

    // 4. Run SMC analysis
    const analysis = analyze(closedCandles, tfKey);

    if (!analysis || analysis.ok !== true) {
      return buildErrorResult({
        symbol: symbolKey,
        timeframe: tfKey,
        message: analysis?.error || "SMC analysis failed or returned an invalid result.",
        startedAt,
        extra: { market: marketSummary, analysis: jsonSafe(analysis) }
      });
    }

    // 5. Higher-timeframe trend (only fetched when there is a trend worth confirming)
    const ltfTrend = String(analysis.trend ?? "").toLowerCase();
    let htf = { timeframe: null, trend: null, error: null };

    if (options.htfTrend) {
      htf = { timeframe: "manual", trend: String(options.htfTrend).toLowerCase(), error: null };
    } else if (ltfTrend === "bullish" || ltfTrend === "bearish") {
      htf = await loadHtfTrend(env, symbolKey, tfKey);
    }

    // 6. Evaluate the setup
    const currentPrice = chartCandles[chartCandles.length - 1].close;
    const lastClosed = closedCandles[closedCandles.length - 1];

    const setup = evaluateSetup(analysis, currentPrice, {
      ...options,
      htfTrend: htf.trend,
      htfError: htf.error,
      lastCandle: {
        open: Number(lastClosed.open),
        high: Number(lastClosed.high),
        low: Number(lastClosed.low),
        close: Number(lastClosed.close)
      },
      timestamp: options.timestamp ?? Number(lastClosed.time)
    });

    if (!setup || typeof setup !== "object") {
      return buildErrorResult({
        symbol: symbolKey,
        timeframe: tfKey,
        message: "Setup evaluator returned no valid result.",
        startedAt,
        extra: { market: marketSummary, analysis: jsonSafe(analysis) }
      });
    }

    // 7. Create annotations
    const annotations = buildChartAnnotations(analysis, setup);
    const decision = setup.decision ?? "NO_TRADE";

    return {
      ok: true,
      engineVersion: ENGINE_VERSION,
      status: decision === "NO_TRADE" ? (setup.watch ? "SETUP_FORMING" : "NO_TRADE") : "SETUP_FOUND",
      symbol: symbolKey,
      symbolName: SYMBOLS[symbolKey].name,
      timeframe: tfKey,
      provider: market.provider ?? "unknown",
      fetchedAt: market.fetchedAt ?? null,
      cached: Boolean(market.cached),
      processingMs: Date.now() - startedAt,
      htf: { timeframe: htf.timeframe, trend: htf.trend },
      market: marketSummary,
      analysis: jsonSafe(analysis),
      setup: jsonSafe(setup),
      annotations: Array.isArray(annotations) ? jsonSafe(annotations) : [],
      signal: {
        decision,
        direction: setup.direction ?? null,
        watch: Boolean(setup.watch),
        score: setup.score ?? null,
        maxScore: setup.maxScore ?? null,
        confidenceLabel: setup.confidenceLabel ?? null,
        session: setup.session ?? null,
        reasons: Array.isArray(setup.reasons) ? jsonSafe(setup.reasons) : [],
        evidence: Array.isArray(setup.evidence) ? jsonSafe(setup.evidence) : [],
        candidateZone: jsonSafe(setup.candidateZone ?? null),
        levels: jsonSafe(setup.levels ?? null),
        entryStatus: setup.entryStatus ?? null
      }
    };

  } catch (error) {
    console.error("SKY AI SIGNAL ENGINE ERROR", {
      symbol: symbolKey,
      timeframe: tfKey,
      message: error?.message,
      stack: error?.stack
    });

    return buildErrorResult({
      symbol: symbolKey,
      timeframe: tfKey,
      message: error?.message || "Unexpected signal engine error.",
      startedAt
    });
  }
}

/**
 * Compatibility wrapper
 */
export async function runSignalEngine(
  env,
  symbolKey = "XAUUSD",
  tfKey = "M15"
) {
  const result = await getSignal(env, symbolKey, tfKey);
  return JSON.stringify(result);
}
