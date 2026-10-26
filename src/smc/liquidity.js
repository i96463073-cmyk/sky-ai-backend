// Liquidity pools, equal highs/lows and sweeps.
// Buy-side liquidity rests above swing highs / equal highs; sell-side below swing lows / equal lows.
// SWEEP of a buy-side level: a candle wicks above it by at least sweepMinAtr x ATR but CLOSES back below.
// A candle that closes beyond the level is a BREAK, not a sweep.
import { fmt } from "./util.js";

export function resolveLevel(candles, atr, side, level, fromIndex, cfg) {
  for (let i = fromIndex; i < candles.length; i++) {
    const c = candles[i];
    const a = i > 0 ? atr[i - 1] : null;
    const minDepth = a == null ? 0 : cfg.sweepMinAtr * a;
    if (side === "buy") {
      if (c.high > level) {
        const depth = c.high - level;
        if (c.close > level) return { status: "broken", index: i, depth };
        if (c.close < level && depth >= minDepth) return { status: "swept", index: i, depth };
      }
    } else if (c.low < level) {
      const depth = level - c.low;
      if (c.close < level) return { status: "broken", index: i, depth };
      if (c.close > level && depth >= minDepth) return { status: "swept", index: i, depth };
    }
  }
  return { status: "unswept", index: null, depth: null };
}

export function analyzeLiquidity(candles, swings, atr, cfg) {
  const pools = [];
  const add = (side, kind, level, formedIndex, extra) => {
    const r = resolveLevel(candles, atr, side, level, formedIndex + 1, cfg);
    pools.push({
      side, kind, level, formedIndex, formedTime: candles[formedIndex].iso,
      status: r.status,
      resolvedIndex: r.index,
      resolvedTime: r.index == null ? null : candles[r.index].iso,
      depth: r.depth,
      ...extra
    });
  };

  for (const s of swings) {
    const side = s.type === "high" ? "buy" : "sell";
    add(side, "swing", s.price, s.confirmIndex, {
      swingIndex: s.index,
      why: `Confirmed swing ${s.type} at ${fmt(s.price)} (${s.time}); ${side}-side liquidity rests beyond it.`
    });
  }

  for (const type of ["high", "low"]) {
    const list = swings.filter(s => s.type === type);
    for (let j = 1; j < list.length; j++) {
      const sj = list[j];
      const tol = cfg.eqAtrFactor * (atr[sj.confirmIndex] ?? 0);
      if (!(tol > 0)) continue;
      for (let m = j - 1; m >= Math.max(0, j - 8); m--) {
        const si = list[m];
        if (Math.abs(si.price - sj.price) > tol) continue;
        const level = type === "high" ? Math.max(si.price, sj.price) : Math.min(si.price, sj.price);
        let clean = true;
        for (let q = si.index + 1; q < sj.index; q++) {
          if (type === "high" ? candles[q].high > level + tol : candles[q].low < level - tol) { clean = false; break; }
        }
        if (!clean) continue;
        add(type === "high" ? "buy" : "sell", "equal", level, sj.confirmIndex, {
          swingIndices: [si.index, sj.index],
          tolerance: tol,
          why: `Two swing ${type}s at ${fmt(si.price)} and ${fmt(sj.price)} are within ${fmt(tol)} (${cfg.eqAtrFactor} x ATR) with no candle pushing beyond them in between.`
        });
        break;
      }
    }
  }
  pools.sort((a, b) => a.formedIndex - b.formedIndex);

  const seen = new Map();
  for (const p of pools) {
    if (p.status !== "swept") continue;
    const key = p.side + "|" + p.resolvedIndex + "|" + p.level;
    if (!seen.has(key) || p.kind === "equal") seen.set(key, p);
  }
  const sweeps = [...seen.values()]
    .sort((a, b) => a.resolvedIndex - b.resolvedIndex)
    .map(p => ({
      type: "SWEEP",
      side: p.side,
      direction: p.side === "buy" ? "bearish" : "bullish",
      kind: p.kind,
      level: p.level,
      index: p.resolvedIndex,
      time: p.resolvedTime,
      depth: p.depth,
      why: `Candle ${p.resolvedTime} wicked ${fmt(p.depth)} through the ${p.side}-side ${p.kind} level ${fmt(p.level)} and closed back ${p.side === "buy" ? "below" : "above"} it.`
    }));
  return { pools, sweeps };
}
