// Session helpers (fixed UTC hours, see config). Only meaningful for timeframes of 1 hour or less.
import { fmt } from "./util.js";

export function sessionsAt(ms, cfg) {
  const h = new Date(ms).getUTCHours();
  return Object.entries(cfg.sessions).filter(([, s]) => h >= s.start && h < s.end).map(([name]) => name);
}

// Range of one session on the UTC date of the newest candle. complete=false while the session is still running.
export function sessionRange(candles, name, stepMs, cfg) {
  if (stepMs > 3600000) return { available: false, reason: "Timeframe too coarse for session ranges" };
  const s = cfg.sessions[name];
  const last = candles[candles.length - 1];
  const d = new Date(last.time);
  const dayStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
  const from = dayStart + s.start * 3600000;
  const to = dayStart + s.end * 3600000;
  const inside = candles.filter(c => c.time >= from && c.time < to);
  if (!inside.length) return { available: false, reason: "No candles in this session yet" };
  const high = Math.max(...inside.map(c => c.high));
  const low = Math.min(...inside.map(c => c.low));
  const complete = last.time + stepMs >= to;
  return {
    available: true, session: name, high, low, complete,
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    why: `${name} session (${s.start}:00-${s.end}:00 UTC) high ${fmt(high)}, low ${fmt(low)}${complete ? "" : " (session still in progress)"}.`
  };
}
