
import { DEFAULTS, ENGINE_VERSION } from "./config.js";
import { computeAtr } from "./atr.js";
import { detectSwings } from "./swings.js";
import { analyzeStructure } from "./structure.js";
import { analyzeLiquidity } from "./liquidity.js";
import { detectDisplacement } from "./displacement.js";
import { detectFvgs } from "./fvg.js";
import { detectOrderBlocks } from "./orderblocks.js";
import { dealingRange } from "./ranges.js";
import { sessionsAt, sessionRange } from "./sessions.js";
import { previousLevels } from "./levels.js";
import { TIMEFRAMES } from "../market/symbols.js";

export function analyze(allCandles, tfKey, userConfig = {}) {
  const tf = TIMEFRAMES[tfKey];

  if (!tf) {
    return {
      ok: false,
      code: "INVALID_TIMEFRAME",
      message: `Unsupported timeframe: ${tfKey}`
    };
  }

  if (!Array.isArray(allCandles)) {
    return {
      ok: false,
      code: "INVALID_CANDLES",
      message: "Candles must be an array."
    };
  }

  const cfg = {
    ...DEFAULTS,
    ...userConfig,
    sessions: {
      ...DEFAULTS.sessions,
      ...(userConfig.sessions || {})
    }
  };

  const candles = allCandles
    .filter(c => c && c.closed === true)
    .slice()
    .sort((a, b) => a.time - b.time);

  // Reject invalid OHLC values instead of letting indicators use them.
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const values = [c.open, c.high, c.low, c.close];

    if (
      !Number.isFinite(c.time) ||
      values.some(v => !Number.isFinite(v) || v <= 0) ||
      c.high < Math.max(c.open, c.close, c.low) ||
      c.low > Math.min(c.open, c.close, c.high)
    ) {
      return {
        ok: false,
        code: "INVALID_CANDLE",
        message: `Invalid closed candle at index ${i}.`
      };
    }

    if (
      i > 0 &&
      candles[i].time === candles[i - 1].time
    ) {
      return {
        ok: false,
        code: "DUPLICATE_CANDLE_TIME",
        message: "Duplicate candle timestamps detected."
      };
    }
  }

  const needed =
    cfg.swingLeft +
    cfg.swingRight +
    cfg.atrPeriod + 2;

  if (candles.length < needed) {
    return {
      ok: false,
      code: "INSUFFICIENT_DATA",
      message: `Need at least ${needed} closed candles, have ${candles.length}.`
    };
  }

  const atr = computeAtr(candles, cfg.atrPeriod);
  const swings = detectSwings(
    candles,
    cfg.swingLeft,
    cfg.swingRight
  );

  const structure = analyzeStructure(candles, swings);
  const liquidity = analyzeLiquidity(candles, swings, atr, cfg);
  const displacement = detectDisplacement(candles, atr, cfg);
  const fvg = detectFvgs(candles, atr, displacement, cfg);
  const orderBlocks = detectOrderBlocks(
    candles,
    displacement,
    structure.events,
    cfg
  );

  const last = candles[candles.length - 1];
  const lastAtr = atr[atr.length - 1];

  if (!Number.isFinite(lastAtr) || lastAtr <= 0) {
    return {
      ok: false,
      code: "INVALID_ATR",
      message: "ATR could not be calculated reliably."
    };
  }

  return {
    ok: true,
    engineVersion: ENGINE_VERSION,
    timeframe: tfKey,
    config: cfg,
    candlesAnalysed: candles.length,
    lastClosedCandle: {
      time: last.iso,
      close: last.close
    },
    atr: {
      period: cfg.atrPeriod,
      value: lastAtr
    },
    trend: structure.trend,
    swings: structure.swings,
    structureEvents: structure.events,
    liquidityPools: liquidity.pools,
    sweeps: liquidity.sweeps,
    displacement,
    fvg,
    orderBlocks,
    dealingRange: dealingRange(
      structure,
      last.close,
      lastAtr,
      cfg
    ),
    levels: previousLevels(candles, tf.ms),
    sessions: {
      activeNow: sessionsAt(last.time, cfg),
      asia: sessionRange(candles, "asia", tf.ms, cfg),
      london: sessionRange(candles, "london", tf.ms, cfg),
      newyork: sessionRange(candles, "newyork", tf.ms, cfg)
    }
  };
}
