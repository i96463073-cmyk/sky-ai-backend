// Deterministic synthetic candles for engine tests (seeded, no randomness at test time).
export function rng(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function synthCandles(n, { seed = 1, start = Date.parse("2026-10-19T00:00:00Z"), step = 900000, base = 4000, vol = 1.5 } = {}) {
  const r = rng(seed);
  let price = base;
  let drift = 0;
  const out = [];
  for (let i = 0; i < n; i++) {
    if (i % 40 === 0) drift = (r() - 0.5) * 0.8;
    const impulse = r() < 0.07 ? (r() < 0.5 ? -1 : 1) * vol * (3 + r() * 3) : 0;
    const open = price;
    const close = open + (r() - 0.5) * vol * 2 + drift + impulse;
    const high = Math.max(open, close) + r() * vol * 0.8;
    const low = Math.min(open, close) - r() * vol * 0.8;
    const time = start + i * step;
    out.push({ time, iso: new Date(time).toISOString(), open, high, low, close, tickVolume: 100, closed: true });
    price = close;
  }
  return out;
}

export function toProviderPayload(candles, symbol, interval) {
  const bars = candles.map((c, i) => ({
    openTime: new Date(c.time).toISOString().replace(".000Z", "Z"),
    open: c.open, high: c.high, low: c.low, close: c.close,
    volume: 0, tickVolume: c.tickVolume, isOpen: i === candles.length - 1
  }));
  return { symbol, interval, bars: bars.reverse() };
}

// Hand-built candle: mk(index, open, high, low, close)
export function mk(i, o, h, l, c, step = 900000, start = Date.parse("2026-10-26T00:00:00Z")) {
  const time = start + i * step;
  return { time, iso: new Date(time).toISOString(), open: o, high: h, low: l, close: c, tickVolume: 1, closed: true };
}
