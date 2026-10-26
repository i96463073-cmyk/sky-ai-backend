// Wilder ATR. atr[i] uses only candles 0..i. null until `period` candles exist.
export function computeAtr(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  const tr = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const t = i === 0
      ? c.high - c.low
      : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close));
    tr.push(t);
    if (i === period - 1) out[i] = tr.reduce((a, b) => a + b, 0) / period;
    else if (i >= period) out[i] = (out[i - 1] * (period - 1) + t) / period;
  }
  return out;
}
