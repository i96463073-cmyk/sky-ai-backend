import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULTS } from "../src/smc/config.js";
import { computeAtr } from "../src/smc/atr.js";
import { detectSwings } from "../src/smc/swings.js";
import { analyzeStructure } from "../src/smc/structure.js";
import { analyzeLiquidity, resolveLevel } from "../src/smc/liquidity.js";
import { detectDisplacement } from "../src/smc/displacement.js";
import { detectFvgs } from "../src/smc/fvg.js";
import { detectOrderBlocks } from "../src/smc/orderblocks.js";
import { dealingRange } from "../src/smc/ranges.js";
import { sessionsAt, sessionRange } from "../src/smc/sessions.js";
import { previousLevels } from "../src/smc/levels.js";
import { analyze } from "../src/smc/analyze.js";
import { mk, synthCandles } from "./synth.js";

const flat = (n, v) => new Array(n).fill(v);
const cfg = { ...DEFAULTS };

test("ATR is null before the period, then Wilder-smoothed, and uses no future candles", () => {
  const c = synthCandles(40, { seed: 3 });
  const a = computeAtr(c, 14);
  assert.equal(a[12], null);
  assert.ok(a[13] > 0);
  const short = computeAtr(c.slice(0, 30), 14);
  assert.deepEqual(a.slice(0, 30), short);
  const flatC = Array.from({ length: 20 }, (_, i) => mk(i, 10, 11, 9, 10));
  assert.equal(computeAtr(flatC, 14)[19], 2);
});

test("swing detection: confirmed only after `right` candles; flat top gives one swing", () => {
  const c = [
    mk(0, 1, 2, 0.5, 1.5), mk(1, 1.5, 3, 1, 2), mk(2, 2, 5, 1.5, 4),
    mk(3, 4, 4.5, 2, 3), mk(4, 3, 3.5, 1, 2), mk(5, 2, 2.5, 0.8, 1)
  ];
  const s = detectSwings(c, 2, 2);
  const high = s.find(x => x.type === "high");
  assert.equal(high.index, 2);
  assert.equal(high.price, 5);
  assert.equal(high.confirmIndex, 4);
  assert.equal(detectSwings(c, 2, 2).filter(x => x.type === "high").length, 1);

  const plateau = [mk(0, 1, 2, 1, 1.5), mk(1, 1, 3, 1, 2), mk(2, 2, 5, 1.5, 4), mk(3, 4, 5, 2, 3), mk(4, 3, 3.5, 1.4, 2)];
  assert.equal(detectSwings(plateau, 1, 1).filter(x => x.type === "high").length, 1);
});

const STRUCT = [
  mk(0, 10, 11, 9, 10), mk(1, 10, 12, 10, 11), mk(2, 11, 11.5, 9.5, 10),
  mk(3, 10, 10.5, 8, 9), mk(4, 9, 10, 8.5, 9.5), mk(5, 9.5, 13, 9.4, 12.5),
  mk(6, 12.5, 12.8, 11.5, 12), mk(7, 12, 12.2, 11, 11.2), mk(8, 11.2, 11.6, 7.5, 7.8)
];

test("structure: BOS on close above swing high, then CHOCH on close below swing low", () => {
  const swings = detectSwings(STRUCT, 1, 1);
  const st = analyzeStructure(STRUCT, swings);
  assert.deepEqual(
    st.events.map(e => [e.type, e.direction, e.index, e.level, e.swingIndex]),
    [["BOS", "bullish", 5, 12, 1], ["CHOCH", "bearish", 8, 8, 3]]
  );
  assert.equal(st.trend, "bearish");
  assert.ok(st.events[0].why.includes("closed"));
});

test("a wick beyond a swing is not a break", () => {
  const c = STRUCT.slice(0, 5).concat([mk(5, 9.5, 13, 9.4, 11.9)]);
  const st = analyzeStructure(c, detectSwings(c, 1, 1));
  assert.equal(st.events.length, 0);
  assert.equal(st.trend, "neutral");
});

test("swing labels: HH, HL, LH, LL", () => {
  const swings = [
    { type: "high", index: 1, confirmIndex: 2, price: 10, time: "a" },
    { type: "low", index: 3, confirmIndex: 4, price: 5, time: "b" },
    { type: "high", index: 5, confirmIndex: 6, price: 12, time: "c" },
    { type: "low", index: 7, confirmIndex: 8, price: 6, time: "d" },
    { type: "high", index: 9, confirmIndex: 10, price: 11, time: "e" },
    { type: "low", index: 11, confirmIndex: 12, price: 4, time: "f" }
  ];
  const candles = Array.from({ length: 14 }, (_, i) => mk(i, 8, 9, 7, 8));
  const labels = analyzeStructure(candles, swings).swings.map(s => s.label);
  assert.deepEqual(labels, [null, null, "HH", "HL", "LH", "LL"]);
});

test("liquidity: sweep needs wick through the level and a close back inside", () => {
  const atr = flat(30, 1);
  const base = Array.from({ length: 12 }, (_, i) => mk(i, 99, 99.5, 98.5, 99));
  const sweepC = base.concat([mk(12, 99.5, 101, 99, 99.6)]); // wick 1.0 above 100, closes below
  const brokeC = base.concat([mk(12, 99.5, 101, 99, 100.5)]); // closes above -> break
  const tinyC = base.concat([mk(12, 99.5, 100.02, 99, 99.6), mk(13, 99, 99.5, 98.5, 99)]); // 0.02 < 0.05 ATR
  const sw = resolveLevel(sweepC, atr, "buy", 100, 5, cfg);
  assert.equal(sw.status, "swept");
  assert.equal(sw.index, 12);
  assert.ok(Math.abs(sw.depth - 1) < 1e-9);
  assert.equal(resolveLevel(brokeC, atr, "buy", 100, 5, cfg).status, "broken");
  assert.equal(resolveLevel(tinyC, atr, "buy", 100, 5, cfg).status, "unswept");
  const sellC = base.concat([mk(12, 98.5, 99, 97, 98.4)]);
  assert.equal(resolveLevel(sellC, atr, "sell", 98, 5, cfg).status, "swept");
  const sellBreak = base.concat([mk(12, 98.5, 99, 97, 97.5)]);
  assert.equal(resolveLevel(sellBreak, atr, "sell", 98, 5, cfg).status, "broken");
});

test("liquidity: equal highs within tolerance form a buy-side pool; sweeps are reported once", () => {
  const candles = Array.from({ length: 20 }, (_, i) => mk(i, 99, 99.5, 98.5, 99));
  candles[5] = mk(5, 99, 100, 98.8, 99.2);
  candles[10] = mk(10, 99, 100.04, 98.8, 99.2);
  candles[14] = mk(14, 99, 101, 98.8, 99.3); // sweeps 100.04
  const swings = [
    { type: "high", index: 5, confirmIndex: 6, price: 100, time: candles[5].iso },
    { type: "high", index: 10, confirmIndex: 11, price: 100.04, time: candles[10].iso }
  ];
  const atr = flat(20, 1);
  const { pools, sweeps } = analyzeLiquidity(candles, swings, atr, cfg);
  const eq = pools.find(p => p.kind === "equal");
  assert.equal(eq.side, "buy");
  assert.equal(eq.level, 100.04);
  assert.equal(eq.status, "swept");
  const atLevel = sweeps.filter(s => s.level === 100.04);
  assert.equal(atLevel.length, 1);
  assert.equal(atLevel[0].kind, "equal");
  assert.equal(atLevel[0].direction, "bearish");
  // far apart highs are not equal
  const far = analyzeLiquidity(candles, [swings[0], { ...swings[1], price: 100.5 }], atr, cfg);
  assert.equal(far.pools.filter(p => p.kind === "equal").length, 0);
});

test("displacement: large, decisive body only", () => {
  const atr = flat(5, 1);
  const c = [mk(0, 10, 11, 9, 10), mk(1, 10, 13.3, 9.9, 13), mk(2, 13, 14, 12, 13.6), mk(3, 13, 14, 8, 8.5), mk(4, 8.5, 12, 8, 8.9)];
  const d = detectDisplacement(c, atr, cfg);
  assert.deepEqual(d.map(x => [x.index, x.direction]), [[1, "bullish"], [3, "bearish"]]);
});

test("FVG: exact gap boundaries, size filter, mitigation states", () => {
  const atr = flat(10, 1);
  const base = [mk(0, 9, 10, 8.5, 9.5), mk(1, 9.5, 12, 9.4, 11.8), mk(2, 11.8, 13, 12, 12.9)];
  const f = detectFvgs(base, atr, [{ index: 1 }], cfg);
  assert.equal(f.length, 1);
  assert.equal(f[0].direction, "bullish");
  assert.equal(f[0].bottom, 10);
  assert.equal(f[0].top, 12);
  assert.equal(f[0].middleIsDisplacement, true);
  assert.equal(f[0].status, "unmitigated");

  const partial = base.concat([mk(3, 12.9, 13, 11, 12.5)]);
  assert.equal(detectFvgs(partial, atr, [], cfg)[0].status, "partially_mitigated");
  const filled = partial.concat([mk(4, 12.5, 12.6, 9.5, 9.8)]);
  assert.equal(detectFvgs(filled, atr, [], cfg)[0].status, "filled");

  const bear = [mk(0, 13, 13.5, 12, 12.2), mk(1, 12.2, 12.3, 9.5, 9.8), mk(2, 9.8, 10, 9, 9.2)];
  const b = detectFvgs(bear, atr, [], cfg)[0];
  assert.equal(b.direction, "bearish");
  assert.equal(b.top, 12);
  assert.equal(b.bottom, 10);

  const tiny = [mk(0, 9, 10, 8.5, 9.5), mk(1, 9.5, 10.2, 9.4, 10.1), mk(2, 10.1, 11, 10.05, 10.9)];
  assert.equal(detectFvgs(tiny, atr, [], cfg).length, 0);
  const overlap = [mk(0, 9, 10, 8.5, 9.5), mk(1, 9.5, 11, 9.4, 10.8), mk(2, 10.8, 11.5, 9.9, 11.2)];
  assert.equal(detectFvgs(overlap, atr, [], cfg).length, 0);
});

test("order block: last opposite candle before displacement that breaks structure", () => {
  const c = [
    mk(0, 10, 10.2, 8.8, 9), mk(1, 9, 9.1, 8.4, 8.5), mk(2, 8.5, 12.1, 8.5, 12),
    mk(3, 12, 12.6, 11.8, 12.5), mk(4, 12.5, 12.6, 9.0, 12.2)
  ];
  const disp = [{ index: 2, direction: "bullish" }];
  const ev = [{ type: "BOS", direction: "bullish", index: 3, swingIndex: 0, time: c[3].iso }];
  const ob = detectOrderBlocks(c, disp, ev, cfg);
  assert.equal(ob.length, 1);
  assert.equal(ob[0].candleIndex, 1);
  assert.equal(ob[0].top, 9.1);
  assert.equal(ob[0].bottom, 8.4);
  assert.equal(ob[0].status, "mitigated");
  assert.equal(detectOrderBlocks(c.slice(0, 4), disp, ev, cfg)[0].status, "unmitigated");
  assert.equal(detectOrderBlocks(c, [], ev, cfg).length, 0);
  assert.equal(detectOrderBlocks(c, disp, [{ ...ev[0], swingIndex: 1 }], cfg).length, 0);

  const bear = [
    mk(0, 10, 11.6, 9.9, 11.5), mk(1, 11.5, 11.7, 11, 11.6), mk(2, 11.6, 11.6, 7.9, 8),
    mk(3, 8, 8.2, 7.5, 7.7)
  ];
  const bob = detectOrderBlocks(bear, [{ index: 2, direction: "bearish" }], [{ type: "CHOCH", direction: "bearish", index: 3, swingIndex: 0, time: bear[3].iso }], cfg);
  assert.equal(bob[0].candleIndex, 1);
  assert.equal(bob[0].direction, "bearish");
});

test("premium / discount and dealing range", () => {
  const st = { lastSwingHigh: { price: 110, time: "h" }, lastSwingLow: { price: 100, time: "l" } };
  assert.equal(dealingRange(st, 108, 2, cfg).zone, "premium");
  assert.equal(dealingRange(st, 102, 2, cfg).zone, "discount");
  assert.equal(dealingRange(st, 105, 2, cfg).zone, "equilibrium");
  assert.equal(dealingRange(st, 105, 2, cfg).equilibrium, 105);
  assert.equal(dealingRange(st, 112, 2, cfg).outside, true);
  assert.equal(dealingRange(st, 105, 20, cfg).valid, false);
  assert.equal(dealingRange({ lastSwingHigh: null, lastSwingLow: st.lastSwingLow }, 105, 2, cfg).valid, false);
});

test("sessions: hours and Asian range completeness", () => {
  assert.deepEqual(sessionsAt(Date.parse("2026-10-26T03:00:00Z"), cfg), ["asia"]);
  assert.deepEqual(sessionsAt(Date.parse("2026-10-26T08:00:00Z"), cfg), ["london"]);
  assert.deepEqual(sessionsAt(Date.parse("2026-10-26T13:00:00Z"), cfg), ["london", "newyork"]);
  const day = Date.parse("2026-10-26T00:00:00Z");
  const candles = [];
  for (let i = 0; i < 34; i++) { // 00:00 .. 08:15
    const t = day + i * 900000;
    candles.push({ time: t, iso: new Date(t).toISOString(), open: 100, high: i === 10 ? 105 : 101, low: i === 20 ? 95 : 99, close: 100, closed: true });
  }
  const r = sessionRange(candles, "asia", 900000, cfg);
  assert.equal(r.high, 105);
  assert.equal(r.low, 95);
  assert.equal(r.complete, true);
  const partial = sessionRange(candles.slice(0, 12), "asia", 900000, cfg);
  assert.equal(partial.complete, false);
  assert.equal(sessionRange(candles, "asia", 4 * 3600000, cfg).available, false);
});

function hourly(startIso, endIso, special = {}) {
  const out = [];
  for (let t = Date.parse(startIso); t <= Date.parse(endIso); t += 3600000) {
    const iso = new Date(t).toISOString();
    const o = special[iso.slice(0, 13)] || { high: 101, low: 99 };
    out.push({ time: t, iso, open: 100, high: o.high, low: o.low, close: 100, closed: true });
  }
  return out;
}

test("previous day / previous week high and low", () => {
  const c = hourly("2026-10-12T00:00:00Z", "2026-10-26T07:00:00Z", {
    "2026-10-25T03": { high: 140, low: 60 },
    "2026-10-21T10": { high: 200, low: 50 }
  });
  const l = previousLevels(c, 3600000);
  assert.equal(l.previousDay.high, 140);
  assert.equal(l.previousDay.low, 60);
  assert.equal(l.previousDay.complete, true);
  assert.equal(l.previousWeek.high, 200);
  assert.equal(l.previousWeek.low, 50);
  assert.equal(l.previousWeek.complete, true);
});

test("previous day skips the thin Sunday evening and flags incomplete coverage", () => {
  const fri = hourly("2026-10-23T00:00:00Z", "2026-10-23T20:00:00Z", { "2026-10-23T09": { high: 130, low: 70 } });
  const rest = hourly("2026-10-25T22:00:00Z", "2026-10-26T03:00:00Z");
  const l = previousLevels(fri.concat(rest), 3600000);
  assert.equal(l.previousDay.high, 130);
  assert.equal(l.previousDay.low, 70);
  assert.equal(previousLevels(rest, 3600000).previousDay, null);
  const late = hourly("2026-10-23T06:00:00Z", "2026-10-23T20:00:00Z").concat(rest);
  assert.equal(previousLevels(late, 3600000).previousDay.complete, false);
  assert.equal(previousLevels(rest, 24 * 3600000).available, false);
});

test("full pipeline runs, ignores the forming candle and reports insufficient data", () => {
  const candles = synthCandles(300, { seed: 7 });
  const r = analyze(candles, "M15");
  assert.equal(r.ok, true);
  assert.ok(r.swings.length > 5);
  assert.ok(r.structureEvents.length > 0);
  assert.ok(["bullish", "bearish", "neutral"].includes(r.trend));
  assert.ok(r.sessions.activeNow.length >= 0);
  for (const f of r.fvg) assert.ok(f.top > f.bottom);
  for (const o of r.orderBlocks) assert.ok(o.top > o.bottom);
  for (const e of r.structureEvents) assert.ok(e.why.length > 10);

  const withForming = candles.map((c, i) => (i === 299 ? { ...c, closed: false } : c));
  assert.equal(analyze(withForming, "M15").candlesAnalysed, 299);
  assert.equal(analyze(candles.slice(0, 10), "M15").code, "INSUFFICIENT_DATA");
  assert.deepEqual(analyze(candles, "M15"), analyze(candles, "M15"));
});

test("NO LOOK-AHEAD: analysing a truncated history gives the same detections as the full run", () => {
  const candles = synthCandles(320, { seed: 11 });
  const full = analyze(candles, "M15");
  assert.ok(full.fvg.length > 0 && full.sweeps.length > 0 && full.structureEvents.length > 0);
  for (const k of [150, 200, 250, 300]) {
    const part = analyze(candles.slice(0, k), "M15");
    const last = k - 1;
    const keyEv = e => [e.type, e.direction, e.index, e.level].join();
    assert.deepEqual(part.structureEvents.map(keyEv), full.structureEvents.filter(e => e.index <= last).map(keyEv), "structure @" + k);
    const keySw = e => [e.side, e.index, e.level, e.kind].join();
    assert.deepEqual(part.sweeps.map(keySw), full.sweeps.filter(e => e.index <= last).map(keySw), "sweeps @" + k);
    const keyF = e => [e.direction, e.index, e.top, e.bottom].join();
    assert.deepEqual(part.fvg.map(keyF), full.fvg.filter(e => e.index <= last).map(keyF), "fvg @" + k);
    const keyO = e => [e.direction, e.candleIndex, e.confirmIndex, e.top, e.bottom].join();
    assert.deepEqual(part.orderBlocks.map(keyO), full.orderBlocks.filter(e => e.confirmIndex <= last).map(keyO), "ob @" + k);
    const keyD = e => [e.direction, e.index].join();
    assert.deepEqual(part.displacement.map(keyD), full.displacement.filter(e => e.index <= last).map(keyD), "disp @" + k);
    const keyS = e => [e.type, e.index, e.price].join();
    assert.deepEqual(part.swings.map(keyS), full.swings.filter(e => e.confirmIndex <= last).map(keyS), "swings @" + k);
  }
});
