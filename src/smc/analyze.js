// Orchestrates all detectors on CLOSED candles only (the forming candle is never analysed).
// Deterministic: same candles + same config = same output.
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
  const cfg = { ...DEFAULTS, ...userConfig, sessions: { ...DEFAULTS.sessions, ...(userConfig.sessions || {}) } };
  const stepMs = TIMEFRAMES[tfKey].ms;
  const candles = allCandles.filter(c => c.closed);
  const needed = cfg.swingLeft + cfg.swingRight + cfg.atrPeriod + 2;
  if (candles.length < needed) {
    return { ok: false, code: "INSUFFICIENT_DATA", message: `Need at least ${needed} closed candles, have ${candles.length}` };
  }

  const atr = computeAtr(candles, cfg.atrPeriod);
  const swings = detectSwings(candles, cfg.swingLeft, cfg.swingRight);
  const structure = analyzeStructure(candles, swings);
  const liquidity = analyzeLiquidity(candles, swings, atr, cfg);
  const displacement = detectDisplacement(candles, atr, cfg);
  const fvg = detectFvgs(candles, atr, displacement, cfg);
  const orderBlocks = detectOrderBlocks(candles, displacement, structure.events, cfg);
  const last = candles[candles.length - 1];
  const lastAtr = atr[atr.length - 1];

  return {
    ok: true,
    engineVersion: ENGINE_VERSION,
    timeframe: tfKey,
    config: cfg,
    candlesAnalysed: candles.length,
    lastClosedCandle: { time: last.iso, close: last.close },
    atr: { period: cfg.atrPeriod, value: lastAtr },
    trend: structure.trend,
    swings: structure.swings,
    structureEvents: structure.events,
    liquidityPools: liquidity.pools,
    sweeps: liquidity.sweeps,
    displacement,
    fvg,
    orderBlocks,
    dealingRange: dealingRange(structure, last.close, lastAtr, cfg),
    levels: previousLevels(candles, stepMs),
    sessions: {
      activeNow: sessionsAt(last.time, cfg),
      asia: sessionRange(candles, "asia", stepMs, cfg),
      london: sessionRange(candles, "london", stepMs, cfg),
      newyork: sessionRange(candles, "newyork", stepMs, cfg)
    }
  };
}
