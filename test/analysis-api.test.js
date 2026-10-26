import test, { beforeEach } from "node:test";
import assert from "node:assert/strict";
import { handleApi } from "../src/api.js";
import { _resetForTests } from "../src/market/biquote.js";
import { synthCandles, toProviderPayload } from "./synth.js";

beforeEach(() => _resetForTests());
const candles = synthCandles(300, { seed: 5, start: Date.parse("2026-10-24T20:00:00Z") });
const NOW = candles[candles.length - 1].time + 60000;
const mkDeps = payload => ({ fetchImpl: async () => new Response(JSON.stringify(payload), { status: 200 }), now: () => NOW, sleep: async () => {} });
const get = (path, deps) => handleApi(new Request("https://x.test" + path), {}, deps);

test("/api/analysis returns detections, reliability and the not-a-signal notice", async () => {
  const res = await get("/api/analysis?symbol=XAUUSD&tf=M15", mkDeps(toProviderPayload(candles, "XAUUSD", "15m")));
  const b = await res.json();
  assert.equal(res.status, 200);
  assert.equal(b.ok, true);
  assert.equal(b.analysis.ok, true);
  assert.equal(b.dataReliable, true);
  assert.equal(b.analysis.candlesAnalysed, 299);
  assert.match(b.notice, /not trade signals/);
  assert.equal(b.engineVersion, "smc-0.1.0");
});

test("/api/analysis flags stale data as unreliable", async () => {
  const deps = { ...mkDeps(toProviderPayload(candles, "XAUUSD", "15m")), now: () => NOW + 6 * 3600000 };
  const b = await (await get("/api/analysis?symbol=XAUUSD&tf=M15", deps)).json();
  assert.equal(b.dataReliable, false);
  assert.match(b.reliabilityReasons[0], /stale/i);
});

test("/api/analysis: too little data, bad input and provider failure", async () => {
  const few = toProviderPayload(candles.slice(0, 8), "XAUUSD", "15m");
  const r1 = await get("/api/analysis", mkDeps(few));
  assert.equal(r1.status, 422);
  assert.equal((await r1.json()).error.code, "INSUFFICIENT_DATA");
  assert.equal((await get("/api/analysis?symbol=BTCUSD", mkDeps(few))).status, 400);
  assert.equal((await get("/api/analysis?tf=W1", mkDeps(few))).status, 400);
  _resetForTests();
  const down = { fetchImpl: async () => new Response("x", { status: 503 }), now: () => NOW, sleep: async () => {} };
  const r2 = await get("/api/analysis", down);
  assert.equal(r2.status, 502);
  assert.equal((await r2.json()).analysis, undefined);
});
