// Swing points. A swing high at i: high[i] is strictly above the `left` previous highs
// and at least as high as the `right` following highs (swing lows mirror this).
// confirmIndex = i + right: the swing may NOT be used by any logic before that candle closes.
export function detectSwings(candles, left, right) {
  const swings = [];
  for (let i = left; i < candles.length - right; i++) {
    let isHigh = true;
    let isLow = true;
    for (let k = 1; k <= left; k++) {
      if (candles[i - k].high >= candles[i].high) isHigh = false;
      if (candles[i - k].low <= candles[i].low) isLow = false;
    }
    for (let k = 1; k <= right; k++) {
      if (candles[i + k].high > candles[i].high) isHigh = false;
      if (candles[i + k].low < candles[i].low) isLow = false;
    }
    const base = { index: i, time: candles[i].iso, confirmIndex: i + right };
    if (isHigh) swings.push({ type: "high", price: candles[i].high, ...base });
    if (isLow) swings.push({ type: "low", price: candles[i].low, ...base });
  }
  return swings;
}
