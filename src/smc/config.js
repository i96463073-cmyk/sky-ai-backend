// Tunable parameters for the SMC engine. Every rule in docs/SMC_RULES.md uses these.
export const ENGINE_VERSION = "smc-0.1.0";

export const DEFAULTS = {
  atrPeriod: 14,          // Wilder ATR period
  swingLeft: 3,           // candles to the left that must be lower (highs) / higher (lows)
  swingRight: 3,          // candles to the right; also the confirmation delay
  eqAtrFactor: 0.1,       // equal highs/lows tolerance = factor x ATR
  sweepMinAtr: 0.05,      // minimum wick penetration of a liquidity level = factor x ATR
  dispBodyAtr: 1.5,       // displacement: body >= factor x ATR (ATR of the previous candle)
  dispBodyRatio: 0.6,     // displacement: body / full range >= ratio
  fvgMinAtr: 0.1,         // minimum FVG height = factor x ATR
  obWindow: 3,            // displacement must be within this many candles before the structure break
  obLookback: 5,          // order-block candle is searched this many candles before the displacement
  rangeMinAtr: 1,         // dealing range must be at least this many ATR tall
  // Session hours are fixed UTC approximations (they do not follow daylight saving).
  sessions: {
    asia: { start: 0, end: 7 },
    london: { start: 7, end: 16 },
    newyork: { start: 12, end: 21 }
  }
};
