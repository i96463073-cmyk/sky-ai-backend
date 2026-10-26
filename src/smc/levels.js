// Previous-day and previous-week high/low.
//  Day  = UTC calendar day. A day qualifies only if its candles span >= 12 hours
//         (this skips the thin Sunday-evening open).
//  Week = starts Sunday 22:00 UTC (approximate FX week open).
//  complete=false when the loaded candles do not reach back to the start of that period.
const DAY = 86400000;
const dayStart = ms => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()); };
const weekStart = ms => {
  const shifted = ms + 2 * 3600000;
  const ds = dayStart(shifted);
  return ds - ((new Date(shifted).getUTCDay() + 6) % 7) * DAY - 2 * 3600000;
};

function group(candles, keyFn) {
  const m = new Map();
  for (const c of candles) {
    const k = keyFn(c.time);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(c);
  }
  return m;
}

function summarize(list, startMs, firstTime, stepMs) {
  return {
    high: Math.max(...list.map(c => c.high)),
    low: Math.min(...list.map(c => c.low)),
    from: new Date(startMs).toISOString(),
    complete: firstTime <= startMs + stepMs
  };
}

export function previousLevels(candles, stepMs) {
  if (stepMs > 4 * 3600000) return { available: false, reason: "Timeframe too coarse; use H4 or lower" };
  const last = candles[candles.length - 1];
  const firstTime = candles[0].time;
  const curDay = dayStart(last.time);
  const curWeek = weekStart(last.time);

  const days = group(candles, dayStart);
  const dayKeys = [...days.keys()].filter(k => k < curDay).sort((a, b) => b - a);
  let pd = null;
  for (const k of dayKeys) {
    const list = days.get(k);
    const span = list[list.length - 1].time - list[0].time + stepMs;
    if (span >= 12 * 3600000) { pd = summarize(list, k, firstTime, stepMs); break; }
  }

  const weeks = group(candles, weekStart);
  const weekKeys = [...weeks.keys()].filter(k => k < curWeek).sort((a, b) => b - a);
  const pw = weekKeys.length ? summarize(weeks.get(weekKeys[0]), weekKeys[0], firstTime, stepMs) : null;

  return {
    available: true,
    previousDay: pd && { high: pd.high, low: pd.low, from: pd.from, complete: pd.complete },
    previousWeek: pw && { high: pw.high, low: pw.low, from: pw.from, complete: pw.complete }
  };
}
