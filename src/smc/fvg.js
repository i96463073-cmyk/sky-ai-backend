// Fair Value Gap from three consecutive closed candles c1, c2, c3 (c3 = the newest):
//   bullish: low(c3) > high(c1)  -> gap [high(c1), low(c3)]
//   bearish: high(c3) < low(c1)  -> gap [high(c3), low(c1)]
// Gap height must be >= fvgMinAtr x ATR(c2). Known only once c3 has closed.
// Status: unmitigated -> partially_mitigated (price entered the gap) -> filled (price crossed it fully).
import { fmt } from "./util.js";

export function detectFvgs(candles, atr, displacements, cfg) {
  const dispSet = new Set(displacements.map(d => d.index));
  const out = [];
  for (let i = 2; i < candles.length; i++) {
    const a = atr[i - 1];
    if (a == null) continue;
    const c1 = candles[i - 2];
    const c3 = candles[i];
    let direction = null;
    let bottom;
    let top;
    if (c3.low > c1.high) { direction = "bullish"; bottom = c1.high; top = c3.low; }
    else if (c3.high < c1.low) { direction = "bearish"; bottom = c3.high; top = c1.low; }
    if (!direction) continue;
    const size = top - bottom;
    if (size < cfg.fvgMinAtr * a) continue;

    let status = "unmitigated";
    let mitigatedIndex = null;
    for (let j = i + 1; j < candles.length; j++) {
      const c = candles[j];
      if (direction === "bullish") {
        if (c.low <= bottom) { status = "filled"; mitigatedIndex = j; break; }
        if (c.low < top && status === "unmitigated") { status = "partially_mitigated"; mitigatedIndex = j; }
      } else {
        if (c.high >= top) { status = "filled"; mitigatedIndex = j; break; }
        if (c.high > bottom && status === "unmitigated") { status = "partially_mitigated"; mitigatedIndex = j; }
      }
    }
    out.push({
      type: "FVG", direction, top, bottom, size, index: i, time: candles[i].iso,
      middleIndex: i - 1, middleIsDisplacement: dispSet.has(i - 1),
      status, mitigatedIndex,
      why: `${direction === "bullish" ? "Candle 3 low" : "Candle 3 high"} (${fmt(direction === "bullish" ? c3.low : c3.high)}) leaves a gap from ` +
        `${direction === "bullish" ? "candle 1 high" : "candle 1 low"} (${fmt(direction === "bullish" ? c1.high : c1.low)}); gap ${fmt(bottom)} to ${fmt(top)} is ${fmt(size / a)} x ATR.`
    });
  }
  return out;
}
