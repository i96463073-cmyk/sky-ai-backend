// Dealing range = most recent confirmed swing high and swing low (needs height >= rangeMinAtr x ATR).
// Equilibrium = midpoint. Above it is premium, below is discount.
import { fmt } from "./util.js";

export function dealingRange(structure, close, atrValue, cfg) {
  const hi = structure.lastSwingHigh;
  const lo = structure.lastSwingLow;
  if (!hi || !lo || !(hi.price > lo.price)) return { valid: false, reason: "Need a confirmed swing high above a confirmed swing low" };
  const height = hi.price - lo.price;
  if (atrValue == null || height < cfg.rangeMinAtr * atrValue)
    return { valid: false, reason: "Range is smaller than " + cfg.rangeMinAtr + " x ATR" };
  const equilibrium = (hi.price + lo.price) / 2;
  const zone = close > equilibrium ? "premium" : close < equilibrium ? "discount" : "equilibrium";
  return {
    valid: true, high: hi.price, low: lo.price, highTime: hi.time, lowTime: lo.time,
    equilibrium, zone, outside: close > hi.price || close < lo.price,
    position: (close - lo.price) / height,
    why: `Range ${fmt(lo.price)} to ${fmt(hi.price)}, equilibrium ${fmt(equilibrium)}; last close ${fmt(close)} is in ${zone}.`
  };
}
