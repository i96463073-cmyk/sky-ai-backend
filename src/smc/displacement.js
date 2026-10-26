// Displacement candle: body >= dispBodyAtr x ATR(previous candle) and body/range >= dispBodyRatio.
import { fmt } from "./util.js";

export function detectDisplacement(candles, atr, cfg) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    const a = atr[i - 1];
    if (a == null) continue;
    const c = candles[i];
    const body = Math.abs(c.close - c.open);
    const range = c.high - c.low;
    if (range <= 0) continue;
    if (body >= cfg.dispBodyAtr * a && body / range >= cfg.dispBodyRatio) {
      out.push({
        index: i, time: c.iso,
        direction: c.close > c.open ? "bullish" : "bearish",
        body, atr: a, bodyAtr: body / a,
        why: `Body ${fmt(body)} is ${fmt(body / a)} x ATR (${fmt(a)}) and fills ${fmt((body / range) * 100)}% of the candle range.`
      });
    }
  }
  return out;
}
