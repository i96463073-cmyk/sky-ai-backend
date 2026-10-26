// Order block rule (bullish; bearish mirrors it):
//  1. A bullish BOS/CHOCH closes at index b.
//  2. A bullish displacement candle d exists with b - obWindow <= d <= b.
//  3. The OB is the nearest bearish candle (close < open) before d, within obLookback candles,
//     located after the swing that was broken (index > swingIndex).
//  Zone = that candle's full high-low range. It is only confirmed at index b.
//  Status is judged from candles AFTER b: mitigated (price traded into the zone),
//  invalidated (a candle closed through the far side).
import { fmt } from "./util.js";

export function detectOrderBlocks(candles, displacements, events, cfg) {
  const out = [];
  const used = new Set();
  for (const ev of events) {
    const d = displacements.find(x => x.direction === ev.direction && x.index <= ev.index && x.index >= ev.index - cfg.obWindow);
    if (!d) continue;
    const wantBearishCandle = ev.direction === "bullish";
    let k = -1;
    for (let q = d.index - 1; q >= Math.max(0, d.index - cfg.obLookback); q--) {
      if (q <= ev.swingIndex) break;
      const c = candles[q];
      if (wantBearishCandle ? c.close < c.open : c.close > c.open) { k = q; break; }
    }
    if (k < 0) continue;
    const key = ev.direction + "|" + k;
    if (used.has(key)) continue;
    used.add(key);

    const ob = candles[k];
    const top = ob.high;
    const bottom = ob.low;
    let status = "unmitigated";
    let mitigatedIndex = null;
    for (let j = ev.index + 1; j < candles.length; j++) {
      const c = candles[j];
      if (ev.direction === "bullish") {
        if (c.close < bottom) { status = "invalidated"; mitigatedIndex = j; break; }
        if (c.low <= top && status === "unmitigated") { status = "mitigated"; mitigatedIndex = j; }
      } else {
        if (c.close > top) { status = "invalidated"; mitigatedIndex = j; break; }
        if (c.high >= bottom && status === "unmitigated") { status = "mitigated"; mitigatedIndex = j; }
      }
    }
    out.push({
      type: "OB", direction: ev.direction, top, bottom,
      candleIndex: k, time: ob.iso, displacementIndex: d.index, confirmIndex: ev.index,
      structureEvent: ev.type, status, mitigatedIndex,
      why: `Last ${wantBearishCandle ? "bearish" : "bullish"} candle (${ob.iso}) before a ${ev.direction} displacement that produced a ${ev.type} at ${ev.time}; zone ${fmt(bottom)} to ${fmt(top)}.`
    });
  }
  return out;
}
