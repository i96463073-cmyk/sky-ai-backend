// Market structure from confirmed swings: HH/HL/LH/LL labels, BOS and CHOCH.
// A break needs a candle CLOSE beyond the most recent unbroken swing (wicks do not count).
// BOS = break in the direction of the current trend (or the first break from neutral).
// CHOCH = break against the current trend. Each swing can be broken once.
import { fmt } from "./util.js";

export function analyzeStructure(candles, swings) {
  const byConfirm = new Map();
  for (const s of swings) {
    if (!byConfirm.has(s.confirmIndex)) byConfirm.set(s.confirmIndex, []);
    byConfirm.get(s.confirmIndex).push(s);
  }
  let lastHigh = null; // most recent unbroken swing high
  let lastLow = null;
  let prevHigh = null; // most recent swing high of any state
  let prevLow = null;
  let trend = "neutral";
  const events = [];
  const labeled = [];

  for (let i = 0; i < candles.length; i++) {
    for (const s of byConfirm.get(i) || []) {
      let label = null;
      if (s.type === "high") {
        if (prevHigh) label = s.price > prevHigh.price ? "HH" : s.price < prevHigh.price ? "LH" : "EQH";
        prevHigh = s;
        lastHigh = s;
      } else {
        if (prevLow) label = s.price > prevLow.price ? "HL" : s.price < prevLow.price ? "LL" : "EQL";
        prevLow = s;
        lastLow = s;
      }
      labeled.push({ ...s, label });
    }
    const c = candles[i];
    if (lastHigh && c.close > lastHigh.price) {
      const type = trend === "bearish" ? "CHOCH" : "BOS";
      events.push({
        type, direction: "bullish", index: i, time: c.iso, level: lastHigh.price,
        swingIndex: lastHigh.index, swingTime: lastHigh.time,
        why: `Candle closed at ${fmt(c.close)}, above the swing high ${fmt(lastHigh.price)} (${lastHigh.time}). ` +
          (type === "CHOCH" ? "Trend was bearish, so this is a bullish change of character." : "This continues or starts a bullish structure.")
      });
      trend = "bullish";
      lastHigh = null;
    } else if (lastLow && c.close < lastLow.price) {
      const type = trend === "bullish" ? "CHOCH" : "BOS";
      events.push({
        type, direction: "bearish", index: i, time: c.iso, level: lastLow.price,
        swingIndex: lastLow.index, swingTime: lastLow.time,
        why: `Candle closed at ${fmt(c.close)}, below the swing low ${fmt(lastLow.price)} (${lastLow.time}). ` +
          (type === "CHOCH" ? "Trend was bullish, so this is a bearish change of character." : "This continues or starts a bearish structure.")
      });
      trend = "bearish";
      lastLow = null;
    }
  }
  return { trend, events, swings: labeled, lastSwingHigh: prevHigh, lastSwingLow: prevLow };
}
