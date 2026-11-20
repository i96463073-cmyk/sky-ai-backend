// ============================================================
// SKY AI — CHART IMAGE
// Draws a marked-up chart picture (SVG) that explains a trade step by step:
// candles, liquidity sweep, break of structure, order block, fair value gap,
// premium/discount line, entry, stop, targets, and a numbered explanation under it.
// The picture is built from REAL candles and the engine's own analysis, never from an image generator,
// so every mark sits at a real price.
// ============================================================

const W = 1000;
const C = {
  bg: "#0B0E14", card: "#131824", stroke: "#2A3449", text: "#E6E9F0", muted: "#8A93A6",
  up: "#00E676", down: "#FF3B5C", amber: "#FFB300", purple: "#8C52FF", purpleL: "#B388FF", blue: "#2196F3", white: "#FFFFFF"
};
const FONT = "Helvetica, Arial, sans-serif";

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const digits = (s) => (String(s).startsWith("XAU") ? 2 : String(s).endsWith("JPY") ? 3 : 5);
const pipSize = (s) => (String(s).includes("JPY") ? 0.01 : String(s).includes("XAU") ? 0.1 : 0.0001);

const tzFmt = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Africa/Nairobi", day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
});
const eat = (ms) => (Number.isFinite(ms) ? tzFmt.format(new Date(ms)).replace(",", "") + " EAT" : "—");

function wrap(text, max) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).trim().length > max) { if (cur) lines.push(cur); cur = w; } else cur = (cur + " " + w).trim();
  }
  if (cur) lines.push(cur);
  return lines;
}

function idxOf(candles, iso) {
  if (!iso) return -1;
  let i = candles.findIndex((c) => c.iso === iso);
  if (i >= 0) return i;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return -1;
  return candles.findIndex((c) => c.time * 1000 === ms);
}

function message(text) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} 300" width="100%"><rect width="${W}" height="300" fill="${C.bg}"/>` +
    `<text x="${W / 2}" y="150" fill="${C.amber}" font-family="${FONT}" font-size="26" text-anchor="middle">${esc(text)}</text></svg>`;
}

// Works out what to draw. Uses what the engine stored with the trade; falls back to the current analysis.
function resolveEvidence(analysis, trade, candles) {
  const ev = trade?.evidence && typeof trade.evidence === "object" && !Array.isArray(trade.evidence) ? trade.evidence : null;
  const out = { sweep: null, event: null, disp: null, block: null, fvg: null, range: null, cap: null };
  const fromAnalysisRange = analysis?.dealingRange?.valid
    ? { high: num(analysis.dealingRange.high), low: num(analysis.dealingRange.low), eq: num(analysis.dealingRange.equilibrium) } : null;

  if (ev) {
    if (ev.sweep) out.sweep = { idx: idxOf(candles, ev.sweep.time), level: num(ev.sweep.level) };
    if (ev.event) out.event = { idx: idxOf(candles, ev.event.time), swingIdx: idxOf(candles, ev.event.swingTime), level: num(ev.event.level), type: ev.event.type };
    if (ev.displacement) out.disp = { idx: idxOf(candles, ev.displacement.time) };
    if (ev.block) out.block = { idx: idxOf(candles, ev.block.time), top: num(ev.block.top), bottom: num(ev.block.bottom) };
    if (ev.fvg) out.fvg = { idx: idxOf(candles, ev.fvg.time), top: num(ev.fvg.top), bottom: num(ev.fvg.bottom) };
    if (ev.range) out.range = { high: num(ev.range.high), low: num(ev.range.low), eq: num(ev.range.equilibrium) };
    if (ev.cap) out.cap = ev.cap;
    if (!out.range) out.range = fromAnalysisRange;
    return out;
  }

  // fallback: rebuild from the current analysis
  if (!analysis) return out;
  const trend = trade ? (trade.direction === "BUY" ? "bullish" : "bearish") : analysis.trend;
  out.range = fromAnalysisRange;
  if (trend !== "bullish" && trend !== "bearish") return out;
  const ref = num(trade?.entry) ?? candles[candles.length - 1].close;
  const gap = (o) => (ref < o.bottom ? o.bottom - ref : ref > o.top ? ref - o.top : 0);
  const block = (analysis.orderBlocks || []).filter((o) => o.direction === trend && o.status !== "invalidated")
    .sort((a, b) => gap(a) - gap(b) || b.candleIndex - a.candleIndex)[0];
  if (!block) return out;
  out.block = { idx: block.candleIndex, top: num(block.top), bottom: num(block.bottom) };
  const event = (analysis.structureEvents || []).find((e) => e.index === block.confirmIndex);
  if (event) out.event = { idx: event.index, swingIdx: event.swingIndex, level: num(event.level), type: event.type };
  const di = block.displacementIndex ?? block.candleIndex;
  out.disp = { idx: di };
  const sweep = [...(analysis.sweeps || [])].filter((s) => s.direction === trend && s.index <= di).sort((a, b) => b.index - a.index)[0];
  if (sweep) out.sweep = { idx: sweep.index, level: num(sweep.level) };
  const fvg = (analysis.fvg || []).find((f) => f.direction === trend && f.index >= block.candleIndex && f.index <= (block.confirmIndex ?? 0) + 2 && f.status !== "filled");
  if (fvg) out.fvg = { idx: fvg.index, top: num(fvg.top), bottom: num(fvg.bottom) };
  return out;
}

export function renderExplainSvg({ symbol, tf, candles, analysis, trade, now = Date.now(), verdict = null, htf = null }) {
  const sym = String(symbol || "").toUpperCase();
  if (!Array.isArray(candles) || candles.length < 5) return message("Not enough candle data to draw this chart.");
  if (!trade) return renderMapSvg({ symbol: sym, tf, candles, analysis, now, verdict, htf });
  const d = digits(sym);
  const fx = (v) => Number(v).toFixed(d);
  const n = candles.length;

  const dir = trade ? trade.direction : null;
  const bull = dir ? dir === "BUY" : analysis?.trend === "bullish";
  const entry = num(trade?.entry), sl = num(trade?.stop_loss);
  const tps = (trade?.take_profit || []).map(num).filter((v) => v !== null);
  const risk = entry !== null && sl !== null ? Math.abs(entry - sl) : null;
  const ev = resolveEvidence(analysis, trade, candles);

  // ---- which candles to show ----
  const createdMs = Date.parse(trade?.created_at || "");
  let entryIdx = -1;
  if (Number.isFinite(createdMs)) {
    for (let i = 0; i < n; i++) if (candles[i].time * 1000 <= createdMs) entryIdx = i;
  }
  const closedMs = Date.parse(trade?.closed_at || "");
  let closeIdx = -1;
  if (Number.isFinite(closedMs)) for (let i = 0; i < n; i++) if (candles[i].time * 1000 <= closedMs) closeIdx = i;

  const marks = [ev.sweep?.idx, ev.event?.swingIdx, ev.event?.idx, ev.disp?.idx, ev.block?.idx, ev.fvg?.idx, entryIdx].filter((v) => Number.isInteger(v) && v >= 0);
  let end = closeIdx >= 0 ? Math.min(n - 1, closeIdx + 8) : n - 1;
  let start = marks.length ? Math.max(0, Math.min(...marks) - 10) : Math.max(0, end - 79);
  if (end - start + 1 > 150) start = end - 149;
  if (end - start + 1 < 60) start = Math.max(0, end - 59);
  const count = end - start + 1;
  const vis = (i) => Number.isInteger(i) && i >= start && i <= end;

  // ---- geometry ----
  const X0 = 20, X1 = 862, Y0 = 190, Y1 = 790, FUT = 12;
  const slot = (X1 - X0) / (count + FUT);
  const bodyW = Math.max(3, slot * 0.62);
  const X = (i) => X0 + (i - start + 0.5) * slot;

  let pmin = Infinity, pmax = -Infinity;
  for (let i = start; i <= end; i++) { pmin = Math.min(pmin, candles[i].low); pmax = Math.max(pmax, candles[i].high); }
  const extra = [sl, ...tps, ev.block?.top, ev.block?.bottom, ev.fvg?.top, ev.fvg?.bottom, ev.range?.eq].filter((v) => v !== null && v !== undefined);
  for (const v of extra) { pmin = Math.min(pmin, v); pmax = Math.max(pmax, v); }
  const pad = (pmax - pmin) * 0.06 || pmax * 0.001;
  pmin -= pad; pmax += pad;
  const Y = (p) => Y1 - ((p - pmin) / (pmax - pmin)) * (Y1 - Y0);
  const clampY = (y) => Math.max(Y0 + 2, Math.min(Y1 - 2, y));

  const out = [];
  const badges = [];
  const labels = [];
  const items = [];   // numbered explanations
  const badge = (x, y, k) => badges.push(
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="${C.amber}" stroke="${C.bg}" stroke-width="2"/>` +
    `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" fill="#000" font-family="${FONT}" font-size="17" font-weight="700" text-anchor="middle">${k}</text>`
  );
  const tag = (y, label, fill, fg = "#fff") => {
    const yy = clampY(y);
    out.push(`<rect x="${X1 + 6}" y="${(yy - 13).toFixed(1)}" width="${W - X1 - 12}" height="26" rx="5" fill="${fill}"/>` +
      `<text x="${(X1 + 6 + (W - X1 - 12) / 2).toFixed(1)}" y="${(yy + 6).toFixed(1)}" fill="${fg}" font-family="${FONT}" font-size="17" font-weight="700" text-anchor="middle">${esc(label)}</text>`);
  };

  // ---- background and grid ----
  out.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" rx="8" fill="${C.card}" stroke="${C.stroke}"/>`);
  for (let g = 0; g <= 5; g++) {
    const p = pmin + ((pmax - pmin) * g) / 5, y = Y(p);
    out.push(`<line x1="${X0}" y1="${y.toFixed(1)}" x2="${X1}" y2="${y.toFixed(1)}" stroke="${C.stroke}" stroke-width="1" opacity="0.6"/>` +
      `<text x="${X1 + 8}" y="${(y + 5).toFixed(1)}" fill="${C.muted}" font-family="${FONT}" font-size="15">${fx(p)}</text>`);
  }

  // ---- premium / discount ----
  if (ev.range && ev.range.high !== null && ev.range.low !== null && ev.range.eq !== null) {
    const yh = clampY(Y(ev.range.high)), ye = clampY(Y(ev.range.eq)), yl = clampY(Y(ev.range.low));
    out.push(`<rect x="${X0}" y="${yh.toFixed(1)}" width="${X1 - X0}" height="${Math.max(0, ye - yh).toFixed(1)}" fill="${C.down}" opacity="0.07"/>`);
    out.push(`<rect x="${X0}" y="${ye.toFixed(1)}" width="${X1 - X0}" height="${Math.max(0, yl - ye).toFixed(1)}" fill="${C.up}" opacity="0.07"/>`);
    out.push(`<line x1="${X0}" y1="${ye.toFixed(1)}" x2="${X1}" y2="${ye.toFixed(1)}" stroke="${C.purpleL}" stroke-width="2" stroke-dasharray="10 7"/>`);
    labels.push(`<rect x="${X0 + 6}" y="${(yh + 4).toFixed(1)}" width="104" height="24" rx="5" fill="${C.bg}" opacity="0.85"/><text x="${X0 + 14}" y="${(yh + 22).toFixed(1)}" fill="${C.down}" font-family="${FONT}" font-size="16" font-weight="700">PREMIUM</text>`);
    labels.push(`<rect x="${X0 + 6}" y="${(yl - 28).toFixed(1)}" width="112" height="24" rx="5" fill="${C.bg}" opacity="0.85"/><text x="${X0 + 14}" y="${(yl - 10).toFixed(1)}" fill="${C.up}" font-family="${FONT}" font-size="16" font-weight="700">DISCOUNT</text>`);
    tag(Y(ev.range.eq), `50% ${fx(ev.range.eq)}`, C.purple);
  }

  // ---- fair value gap ----
  if (ev.fvg && vis(ev.fvg.idx) && ev.fvg.top !== null) {
    const x = X(ev.fvg.idx) - slot, yt = Y(ev.fvg.top), yb = Y(ev.fvg.bottom);
    const xr = Math.min(X1, X(Math.min(end, Math.max(ev.fvg.idx + 14, entryIdx >= 0 ? entryIdx : ev.fvg.idx))) + slot);
    out.push(`<rect x="${x.toFixed(1)}" y="${yt.toFixed(1)}" width="${Math.max(10, xr - x).toFixed(1)}" height="${Math.max(3, yb - yt).toFixed(1)}" fill="${C.blue}" opacity="0.30" stroke="${C.blue}"/>`);
  }

  // ---- order block ----
  if (ev.block && vis(ev.block.idx) && ev.block.top !== null) {
    const x = X(ev.block.idx) - slot / 2, yt = Y(ev.block.top), yb = Y(ev.block.bottom);
    out.push(`<rect x="${x.toFixed(1)}" y="${yt.toFixed(1)}" width="${(X1 - x).toFixed(1)}" height="${Math.max(3, yb - yt).toFixed(1)}" fill="${C.purple}" opacity="0.28" stroke="${C.purple}" stroke-width="2"/>`);
    out.push(`<text x="${(X1 - 8).toFixed(1)}" y="${(yt + 18).toFixed(1)}" fill="${C.purpleL}" font-family="${FONT}" font-size="16" font-weight="700" text-anchor="end">ORDER BLOCK</text>`);
  }

  // ---- position boxes (risk / reward) ----
  if (entry !== null && sl !== null && risk) {
    const x = entryIdx >= start ? X(Math.min(entryIdx, end)) : X0;
    const lastTp = tps.length ? tps[tps.length - 1] : null;
    const ys = Y(sl), ye = Y(entry);
    out.push(`<rect x="${x.toFixed(1)}" y="${Math.min(ys, ye).toFixed(1)}" width="${(X1 - x).toFixed(1)}" height="${Math.abs(ys - ye).toFixed(1)}" fill="${C.down}" opacity="0.16"/>`);
    if (lastTp !== null) {
      const yt = Y(lastTp);
      out.push(`<rect x="${x.toFixed(1)}" y="${Math.min(yt, ye).toFixed(1)}" width="${(X1 - x).toFixed(1)}" height="${Math.abs(yt - ye).toFixed(1)}" fill="${C.up}" opacity="0.13"/>`);
    }
  }

  // ---- candles ----
  for (let i = start; i <= end; i++) {
    const c = candles[i], x = X(i), upc = c.close >= c.open, col = upc ? C.up : C.down;
    const yo = Y(c.open), yc = Y(c.close);
    out.push(`<line x1="${x.toFixed(1)}" y1="${Y(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(c.low).toFixed(1)}" stroke="${col}" stroke-width="2"/>` +
      `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(2, Math.abs(yo - yc)).toFixed(1)}" fill="${col}"/>`);
  }

  let k = 0;

  // ---- 1. liquidity sweep ----
  if (ev.sweep && vis(ev.sweep.idx) && ev.sweep.level !== null) {
    k++;
    const x = X(ev.sweep.idx), y = Y(ev.sweep.level), c = candles[ev.sweep.idx];
    out.push(`<line x1="${Math.max(X0, x - 16 * slot).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 3 * slot).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.amber}" stroke-width="2.5" stroke-dasharray="8 6"/>`);
    out.push(`<circle cx="${x.toFixed(1)}" cy="${Y(bull ? c.low : c.high).toFixed(1)}" r="9" fill="none" stroke="${C.amber}" stroke-width="3"/>`);
    badge(x, clampY(Y(bull ? c.low : c.high) + (bull ? 30 : -30)), k);
    items.push({ n: k, title: "Liquidity sweep",
      text: `Price pushed ${bull ? "below" : "above"} ${fx(ev.sweep.level)}, where many stop-losses sit, and then closed back ${bull ? "above" : "below"} it. Taking those stops is often the first step before a real move ${bull ? "up" : "down"}.` });
  }

  // ---- 2. break of structure ----
  if (ev.event && vis(ev.event.idx) && ev.event.level !== null) {
    k++;
    const y = Y(ev.event.level);
    const xs = vis(ev.event.swingIdx) ? X(ev.event.swingIdx) : X0 + 4, xe = X(ev.event.idx);
    out.push(`<line x1="${xs.toFixed(1)}" y1="${y.toFixed(1)}" x2="${xe.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.white}" stroke-width="2" stroke-dasharray="3 6"/>`);
    out.push(`<text x="${((xs + xe) / 2).toFixed(1)}" y="${(y + (bull ? -10 : 22)).toFixed(1)}" fill="${C.white}" font-family="${FONT}" font-size="16" font-weight="700" text-anchor="middle">${esc(ev.event.type || "BOS")}</text>`);
    badge(Math.max(X0 + 16, xs - 4), clampY(y + (bull ? -30 : 30)), k);
    if (vis(ev.disp?.idx)) {
      const c = candles[ev.disp.idx], x = X(ev.disp.idx);
      out.push(`<rect x="${(x - slot).toFixed(1)}" y="${(Y(c.high) - 6).toFixed(1)}" width="${(slot * 2).toFixed(1)}" height="${(Y(c.low) - Y(c.high) + 12).toFixed(1)}" fill="none" stroke="${C.amber}" stroke-width="2" stroke-dasharray="5 4" rx="4"/>`);
    }
    items.push({ n: k, title: ev.event.type === "CHOCH" ? "Change of character" : "Break of structure",
      text: `A candle closed ${bull ? "above" : "below"} ${fx(ev.event.level)}. This shows ${bull ? "buyers" : "sellers"} took control.${vis(ev.disp?.idx) ? " The dashed box marks the strong candle (displacement) that drove the move." : ""}` });
  }

  // ---- 3. order block ----
  if (ev.block && vis(ev.block.idx) && ev.block.top !== null) {
    k++;
    badge(Math.min(X1 - 40, X(ev.block.idx) + 4 * slot), clampY(Y(ev.block.top) - 20), k);
    items.push({ n: k, title: "Order block (where Sky enters)",
      text: `The last ${bull ? "bearish" : "bullish"} candle before the move: zone ${fx(ev.block.bottom)} to ${fx(ev.block.top)}. Price often comes back here to retest it, and that retest is the entry.` });
  }

  // ---- 4. fair value gap ----
  if (ev.fvg && vis(ev.fvg.idx) && ev.fvg.top !== null) {
    k++;
    badge(X(ev.fvg.idx) - slot - 16, clampY((Y(ev.fvg.top) + Y(ev.fvg.bottom)) / 2), k);
    items.push({ n: k, title: "Fair value gap",
      text: `A gap between ${fx(ev.fvg.bottom)} and ${fx(ev.fvg.top)} formed in the same move, where price travelled too fast. It adds extra confluence.` });
  }

  // ---- 5. premium / discount ----
  if (ev.range && ev.range.eq !== null && trade) {
    k++;
    badge(X0 + 40, clampY(Y(ev.range.eq) - 22), k);
    items.push({ n: k, title: bull ? "Discount zone" : "Premium zone",
      text: `The range ${fx(ev.range.low)} to ${fx(ev.range.high)} is split at the 50% line (${fx(ev.range.eq)}). ${bull ? "Buys are only taken below it, so you buy cheap." : "Sells are only taken above it, so you sell expensive."}` });
  }

  // ---- entry / stop / targets ----
  const status = !trade ? "MARKET MAP" : trade.result ? `CLOSED · ${trade.result}` : trade.watch ? "WATCHLIST · NOT ENTERED" : trade.entered ? "ACTIVE TRADE" : "WAITING FOR ENTRY";
  if (entry !== null && sl !== null && risk) {
    const x = entryIdx >= start ? X(Math.min(entryIdx, end)) : X0;
    out.push(`<line x1="${x.toFixed(1)}" y1="${Y(entry).toFixed(1)}" x2="${X1}" y2="${Y(entry).toFixed(1)}" stroke="${C.white}" stroke-width="2.5"/>`);
    tag(Y(entry), `ENTRY ${fx(entry)}`, C.white, "#000");
    k++;
    badge(Math.min(X1 - 70, x + 30), clampY(Y(entry) + (bull ? 24 : -24)), k);
    const entryText = trade.result ? `Entry ${fx(entry)} was filled after price retested the order block and a strong ${bull ? "bullish" : "bearish"} candle confirmed it.`
      : trade.watch ? `Planned entry ${fx(entry)}. The setup is still forming, so do NOT enter yet. Sky will alert you if it confirms.`
      : trade.entered ? `Entry ${fx(entry)}: price retested the order block and a strong ${bull ? "bullish" : "bearish"} candle confirmed it.`
      : `Planned entry ${fx(entry)}. Price has not reached it yet, so wait; do not chase.`;
    items.push({ n: k, title: "Entry", text: entryText });

    out.push(`<line x1="${x.toFixed(1)}" y1="${Y(sl).toFixed(1)}" x2="${X1}" y2="${Y(sl).toFixed(1)}" stroke="${C.down}" stroke-width="2.5"/>`);
    tag(Y(sl), `SL ${fx(sl)}`, C.down);
    k++;
    badge(Math.min(X1 - 70, x + 30), clampY(Y(sl) + (bull ? 24 : -24)), k);
    items.push({ n: k, title: "Stop loss",
      text: `Stop at ${fx(sl)}, ${(risk / pipSize(sym)).toFixed(1)} pips from entry, just beyond the order block. If price reaches it the idea was wrong, and you lose 1R (the amount you chose to risk).` });

    tps.forEach((tp, i) => {
      const r = Math.abs(tp - entry) / risk;
      out.push(`<line x1="${x.toFixed(1)}" y1="${Y(tp).toFixed(1)}" x2="${X1}" y2="${Y(tp).toFixed(1)}" stroke="${C.up}" stroke-width="2" ${trade?.tp_hit > i ? "" : 'stroke-dasharray="9 6"'}/>`);
      tag(Y(tp), `TP${i + 1} ${r.toFixed(1)}R ${trade?.tp_hit > i ? "✓" : ""}`.trim(), "#0a7a43");
    });
    if (tps.length) {
      k++;
      badge(Math.min(X1 - 70, x + 30), clampY(Y(tps[0]) + (bull ? 24 : -24)), k);
      const list = tps.map((tp, i) => `TP${i + 1} ${fx(tp)} (${(Math.abs(tp - entry) / risk).toFixed(1)}R)`).join(", ");
      items.push({ n: k, title: "Targets and plan",
        text: `${list}. Plan: ${({ 1: "close everything at TP1", 2: "close 50% at TP1 and 50% at TP2", 3: "close 50% at TP1, 30% at TP2 and 20% at TP3" })[Math.min(3, tps.length)]}` +
          `${tps.length > 1 ? ", and move the stop to breakeven after TP1 so the rest cannot lose" : ""}.` });
    }

    if (trade.result && closeIdx >= start) {
      const cx = X(closeIdx), py = trade.exit_price != null ? Y(num(trade.exit_price) ?? entry) : Y(entry);
      const win = trade.result === "WIN";
      out.push(`<circle cx="${cx.toFixed(1)}" cy="${clampY(py).toFixed(1)}" r="11" fill="${win ? C.up : C.down}" stroke="${C.white}" stroke-width="3"/>`);
      out.push(`<text x="${(cx - 16).toFixed(1)}" y="${(clampY(py) - 18).toFixed(1)}" fill="${win ? C.up : C.down}" font-family="${FONT}" font-size="17" font-weight="700" text-anchor="end">EXIT ${Number.isFinite(Number(trade.r_multiple)) ? (trade.r_multiple >= 0 ? "+" : "−") + Math.abs(trade.r_multiple).toFixed(2) + "R" : ""}</text>`);
    }
  }

  if (trade?.result) {
    k++;
    const r = Number(trade.r_multiple);
    items.push({ n: k, title: "Result",
      text: `${trade.result}${Number.isFinite(r) ? ` ${r >= 0 ? "+" : "−"}${Math.abs(r).toFixed(2)}R` : ""} after reaching ${trade.tp_hit ? `TP${trade.tp_hit}` : "the stop"}. Results are counted after partial closes and breakeven.` });
  }
  if (!trade && !items.length) items.push({ n: 1, title: "No setup", text: "No complete setup is visible on this chart right now. Sky only marks a trade when the order block, sweep and structure line up." });

  // ---- header ----
  const head = [];
  head.push(`<text x="30" y="62" fill="${C.text}" font-family="${FONT}" font-size="44" font-weight="700">${esc(sym)}</text>`);
  let px = 30 + sym.length * 29 + 18;
  const pill = (text, fill, fg = "#000") => {
    const w = text.length * 12.5 + 26;
    head.push(`<rect x="${px}" y="30" width="${w.toFixed(0)}" height="40" rx="10" fill="${fill}"/><text x="${(px + w / 2).toFixed(0)}" y="57" fill="${fg}" font-family="${FONT}" font-size="21" font-weight="700" text-anchor="middle">${esc(text)}</text>`);
    px += w + 10;
  };
  if (dir) pill(dir, dir === "BUY" ? C.up : C.down);
  pill(String(tf || "").toUpperCase(), C.stroke, C.white);
  if (trade?.quality && trade.quality !== "WATCHLIST") pill(trade.quality, trade.quality === "B-GRADE" ? C.amber : trade.quality === "HIGH" ? C.up : C.purpleL);
  const sub = trade ? `${status}${Number.isFinite(createdMs) ? "  ·  opened " + eat(createdMs) : ""}` : `${status}  ·  trend ${analysis?.trend || "unknown"}`;
  head.push(`<text x="30" y="104" fill="${trade?.result ? (trade.result === "WIN" ? C.up : C.down) : C.amber}" font-family="${FONT}" font-size="22" font-weight="700">${esc(sub)}</text>`);
  head.push(`<text x="30" y="140" fill="${C.muted}" font-family="${FONT}" font-size="17">Purple = order block  ·  Blue = fair value gap  ·  Amber = sweep  ·  Green/Red = reward/risk</text>`);
  head.push(`<text x="30" y="172" fill="${C.muted}" font-family="${FONT}" font-size="16">${esc(`Last ${count} candles · ${String(tf || "").toUpperCase()} · prices shown to ${d} decimals`)}</text>`);

  // ---- numbered explanations under the chart ----
  const list = [];
  let y = Y1 + 56;
  list.push(`<text x="30" y="${y - 12}" fill="${C.text}" font-family="${FONT}" font-size="28" font-weight="700">How to read this trade</text>`);
  y += 22;
  for (const it of items) {
    const lines = wrap(it.text, 60);
    list.push(`<circle cx="46" cy="${y + 2}" r="16" fill="${C.amber}"/><text x="46" y="${y + 8}" fill="#000" font-family="${FONT}" font-size="19" font-weight="700" text-anchor="middle">${it.n}</text>`);
    list.push(`<text x="76" y="${y + 8}" fill="${C.text}" font-family="${FONT}" font-size="27" font-weight="700">${esc(it.title)}</text>`);
    lines.forEach((ln, i) => list.push(`<text x="76" y="${y + 44 + i * 32}" fill="${C.muted}" font-family="${FONT}" font-size="24">${esc(ln)}</text>`));
    y += 44 + lines.length * 32 + 26;
  }
  y += 6;
  list.push(`<text x="30" y="${y + 10}" fill="${C.muted}" font-family="${FONT}" font-size="16">Built from real candles and Sky's own analysis, drawn ${esc(eat(now))}. For education only, not financial advice.</text>`);
  const H = Math.ceil(y + 44);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMin meet">` +
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>` + head.join("") + out.join("") + labels.join("") + badges.join("") + list.join("") + `</svg>`;
}

// ============================================================
// MARKET MAP: a fully analysed chart when there is no trade.
// Marks structure breaks, sweeps, order blocks, fair value gaps, equal highs/lows, previous-day levels,
// premium/discount, and ends with what Sky is doing and which levels to watch.
// ============================================================
export function renderMapSvg({ symbol, tf, candles, analysis, now = Date.now(), verdict = null, htf = null }) {
  const sym = String(symbol || "").toUpperCase();
  const d = digits(sym), fx = (v) => Number(v).toFixed(d);
  const n = candles.length, lastIdx = n - 1, price = candles[lastIdx].close;
  const a = analysis || {};
  const atr = num(a.atr?.value) || price * 0.001;
  const pips = (v) => (Math.abs(v - price) / pipSize(sym)).toFixed(0);

  // ---- choose what to draw ----
  const events = (a.structureEvents || []).slice(-3);
  const sweeps = (a.sweeps || []).slice(-3);
  const gapTo = (o) => (price < o.bottom ? o.bottom - price : price > o.top ? price - o.top : 0);
  const obs = (a.orderBlocks || []).filter((o) => o.status !== "invalidated" && o.candleIndex >= n - 160)
    .sort((x, y) => gapTo(x) - gapTo(y) || y.candleIndex - x.candleIndex).slice(0, 3);
  const fvgs = (a.fvg || []).filter((f) => f.status !== "filled" && f.index >= n - 120).sort((x, y) => y.index - x.index).slice(0, 2);
  const eqs = (a.liquidityPools || []).filter((p) => p.kind === "equal" && p.status === "unswept" && p.formedIndex >= n - 160)
    .sort((x, y) => Math.abs(x.level - price) - Math.abs(y.level - price)).slice(0, 3);
  const lv = a.levels?.available ? a.levels : null;
  const prevLevels = [];
  if (lv?.previousDay?.complete) { prevLevels.push({ tag: "PDH", level: num(lv.previousDay.high) }, { tag: "PDL", level: num(lv.previousDay.low) }); }
  const marks = [...events.flatMap((e) => [e.swingIndex, e.index]), ...sweeps.map((x) => x.index), ...obs.map((o) => o.candleIndex)]
    .filter((v) => Number.isInteger(v) && v >= 0);

  let start = marks.length ? Math.max(0, Math.min(...marks) - 8) : Math.max(0, n - 80);
  start = Math.max(start, n - 140);
  start = Math.min(start, Math.max(0, n - 60));
  const end = lastIdx, count = end - start + 1;
  const vis = (i) => Number.isInteger(i) && i >= start && i <= end;

  // ---- geometry ----
  const X0 = 20, X1 = 862, Y0 = 190, Y1 = 790, FUT = 10;
  const slot = (X1 - X0) / (count + FUT), bodyW = Math.max(3, slot * 0.62);
  const X = (i) => X0 + (i - start + 0.5) * slot;
  let pmin = Infinity, pmax = -Infinity;
  for (let i = start; i <= end; i++) { pmin = Math.min(pmin, candles[i].low); pmax = Math.max(pmax, candles[i].high); }
  const spread = pmax - pmin;
  const near = (v) => v !== null && v >= pmin - spread * 0.35 && v <= pmax + spread * 0.35;
  for (const o of obs) if (vis(o.candleIndex)) { pmin = Math.min(pmin, o.bottom); pmax = Math.max(pmax, o.top); }
  for (const f of fvgs) if (vis(f.index)) { pmin = Math.min(pmin, f.bottom); pmax = Math.max(pmax, f.top); }
  for (const p of eqs) if (near(num(p.level))) { pmin = Math.min(pmin, p.level); pmax = Math.max(pmax, p.level); }
  for (const p of prevLevels) if (near(p.level)) { pmin = Math.min(pmin, p.level); pmax = Math.max(pmax, p.level); }
  const pad = (pmax - pmin) * 0.06 || price * 0.001;
  pmin -= pad; pmax += pad;
  const Y = (p) => Y1 - ((p - pmin) / (pmax - pmin)) * (Y1 - Y0);
  const clampY = (y) => Math.max(Y0 + 2, Math.min(Y1 - 2, y));

  const out = [], labels = [], badges = [], items = [];
  const badge = (x, y, k) => badges.push(
    `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="14" fill="${C.amber}" stroke="${C.bg}" stroke-width="2"/>` +
    `<text x="${x.toFixed(1)}" y="${(y + 6).toFixed(1)}" fill="#000" font-family="${FONT}" font-size="17" font-weight="700" text-anchor="middle">${k}</text>`);
  const tag = (y, label, fill, fg = "#fff") => {
    const yy = clampY(y);
    out.push(`<rect x="${X1 + 6}" y="${(yy - 13).toFixed(1)}" width="${W - X1 - 12}" height="26" rx="5" fill="${fill}"/>` +
      `<text x="${(X1 + 6 + (W - X1 - 12) / 2).toFixed(1)}" y="${(yy + 6).toFixed(1)}" fill="${fg}" font-family="${FONT}" font-size="17" font-weight="700" text-anchor="middle">${esc(label)}</text>`);
  };

  out.push(`<rect x="${X0}" y="${Y0}" width="${X1 - X0}" height="${Y1 - Y0}" rx="8" fill="${C.card}" stroke="${C.stroke}"/>`);
  for (let g = 0; g <= 5; g++) {
    const p = pmin + ((pmax - pmin) * g) / 5, y = Y(p);
    out.push(`<line x1="${X0}" y1="${y.toFixed(1)}" x2="${X1}" y2="${y.toFixed(1)}" stroke="${C.stroke}" opacity="0.6"/>` +
      `<text x="${X1 + 8}" y="${(y + 5).toFixed(1)}" fill="${C.muted}" font-family="${FONT}" font-size="15">${fx(p)}</text>`);
  }

  // premium / discount
  const rg = a.dealingRange?.valid ? { high: num(a.dealingRange.high), low: num(a.dealingRange.low), eq: num(a.dealingRange.equilibrium), zone: a.dealingRange.zone } : null;
  if (rg && rg.high !== null && rg.low !== null) {
    const yh = clampY(Y(rg.high)), ye = clampY(Y(rg.eq)), yl = clampY(Y(rg.low));
    out.push(`<rect x="${X0}" y="${yh.toFixed(1)}" width="${X1 - X0}" height="${Math.max(0, ye - yh).toFixed(1)}" fill="${C.down}" opacity="0.07"/>`);
    out.push(`<rect x="${X0}" y="${ye.toFixed(1)}" width="${X1 - X0}" height="${Math.max(0, yl - ye).toFixed(1)}" fill="${C.up}" opacity="0.07"/>`);
    out.push(`<line x1="${X0}" y1="${ye.toFixed(1)}" x2="${X1}" y2="${ye.toFixed(1)}" stroke="${C.purpleL}" stroke-width="2" stroke-dasharray="10 7"/>`);
    labels.push(`<rect x="${X0 + 6}" y="${(yh + 4).toFixed(1)}" width="104" height="24" rx="5" fill="${C.bg}" opacity="0.85"/><text x="${X0 + 14}" y="${(yh + 22).toFixed(1)}" fill="${C.down}" font-family="${FONT}" font-size="16" font-weight="700">PREMIUM</text>`);
    labels.push(`<rect x="${X0 + 6}" y="${(yl - 28).toFixed(1)}" width="112" height="24" rx="5" fill="${C.bg}" opacity="0.85"/><text x="${X0 + 14}" y="${(yl - 10).toFixed(1)}" fill="${C.up}" font-family="${FONT}" font-size="16" font-weight="700">DISCOUNT</text>`);
    tag(Y(rg.eq), `50% ${fx(rg.eq)}`, C.purple);
  }

  // fair value gaps (behind candles)
  for (const f of fvgs) if (vis(f.index)) {
    const x = X(f.index) - slot, yt = Y(f.top), yb = Y(f.bottom);
    out.push(`<rect x="${x.toFixed(1)}" y="${yt.toFixed(1)}" width="${Math.max(12, Math.min(X1, X(Math.min(end, f.index + 18)) + slot) - x).toFixed(1)}" height="${Math.max(3, yb - yt).toFixed(1)}" fill="${C.blue}" opacity="0.30" stroke="${C.blue}"/>`);
  }
  // order blocks (behind candles): green = bullish, red = bearish
  for (const o of obs) if (vis(o.candleIndex)) {
    const bullOb = o.direction === "bullish", col = bullOb ? C.up : C.down;
    const x = X(o.candleIndex) - slot / 2, yt = Y(o.top), yb = Y(o.bottom);
    out.push(`<rect x="${x.toFixed(1)}" y="${yt.toFixed(1)}" width="${(X1 - x).toFixed(1)}" height="${Math.max(3, yb - yt).toFixed(1)}" fill="${col}" opacity="0.20" stroke="${col}" stroke-width="2"/>`);
    labels.push(`<text x="${(X1 - 8).toFixed(1)}" y="${(Y((o.top + o.bottom) / 2) + 6).toFixed(1)}" fill="${col}" font-family="${FONT}" font-size="15" font-weight="700" text-anchor="end">${bullOb ? "BULL" : "BEAR"} OB${o.status === "unmitigated" ? "" : " (tapped)"}</text>`);
  }

  // candles
  for (let i = start; i <= end; i++) {
    const c = candles[i], x = X(i), upc = c.close >= c.open, col = upc ? C.up : C.down;
    const yo = Y(c.open), yc = Y(c.close);
    out.push(`<line x1="${x.toFixed(1)}" y1="${Y(c.high).toFixed(1)}" x2="${x.toFixed(1)}" y2="${Y(c.low).toFixed(1)}" stroke="${col}" stroke-width="2"/>` +
      `<rect x="${(x - bodyW / 2).toFixed(1)}" y="${Math.min(yo, yc).toFixed(1)}" width="${bodyW.toFixed(1)}" height="${Math.max(2, Math.abs(yo - yc)).toFixed(1)}" fill="${col}"/>`);
  }

  // swing labels (HH / HL / LH / LL)
  for (const sw of (a.swings || []).filter((x) => vis(x.index) && x.label).slice(-10)) {
    const hi = sw.type === "high", x = X(sw.index), y = Y(sw.price) + (hi ? -9 : 20);
    labels.push(`<text x="${x.toFixed(1)}" y="${clampY(y).toFixed(1)}" fill="${C.text}" font-family="${FONT}" font-size="14" font-weight="700" text-anchor="middle" opacity="0.85">${esc(sw.label)}</text>`);
  }

  let k = 0;

  // 1. structure
  const evVis = events.filter((e) => vis(e.index));
  if (evVis.length) {
    k++;
    for (const e of evVis) {
      const bullE = e.direction === "bullish", y = Y(e.level);
      const xs = vis(e.swingIndex) ? X(e.swingIndex) : X0 + 4, xe = X(e.index);
      out.push(`<line x1="${xs.toFixed(1)}" y1="${y.toFixed(1)}" x2="${xe.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.white}" stroke-width="2" stroke-dasharray="3 6"/>`);
      labels.push(`<text x="${((xs + xe) / 2).toFixed(1)}" y="${(y + (bullE ? -10 : 22)).toFixed(1)}" fill="${C.white}" font-family="${FONT}" font-size="16" font-weight="700" text-anchor="middle">${esc(e.type)}</text>`);
    }
    const le = evVis[evVis.length - 1], bl = le.direction === "bullish";
    badge(Math.max(X0 + 18, X(le.swingIndex ?? le.index) - 6), clampY(Y(le.level) + (bl ? -30 : 30)), k);
    const prev = evVis.length > 1 ? evVis[evVis.length - 2] : null;
    items.push({ n: k, title: "Market structure",
      text: `The last break was a ${le.type === "CHOCH" ? "change of character" : "break of structure"} ${bl ? "up" : "down"} through ${fx(le.level)}, ${lastIdx - le.index === 0 ? "on the latest candle" : (lastIdx - le.index) + " candles ago"}, so ${bl ? "buyers" : "sellers"} have been in control since then.` +
        `${prev && prev.direction !== le.direction ? ` It flipped the earlier ${prev.direction} move.` : ""} The trend reads ${a.trend || "unclear"}${htf ? ` and the higher timeframe is ${htf}` : ""}.` });
  }

  // 2. sweep
  const swVis = sweeps.filter((x) => vis(x.index));
  if (swVis.length) {
    k++;
    for (const sw of swVis) {
      const y = Y(sw.level), x = X(sw.index), c = candles[sw.index], sellSide = sw.direction === "bullish";
      out.push(`<line x1="${Math.max(X0, x - 14 * slot).toFixed(1)}" y1="${y.toFixed(1)}" x2="${(x + 3 * slot).toFixed(1)}" y2="${y.toFixed(1)}" stroke="${C.amber}" stroke-width="2.5" stroke-dasharray="8 6"/>`);
      out.push(`<circle cx="${x.toFixed(1)}" cy="${Y(sellSide ? c.low : c.high).toFixed(1)}" r="9" fill="none" stroke="${C.amber}" stroke-width="3"/>`);
    }
    const ls = swVis[swVis.length - 1], x = X(ls.index), c = candles[ls.index];
    badge(x, clampY(Y(ls.direction === "bullish" ? c.low : c.high) + (ls.direction === "bullish" ? 30 : -30)), k);
    items.push({ n: k, title: "Liquidity sweep",
      text: `Price took the ${ls.direction === "bullish" ? "sell-side liquidity (stops under lows)" : "buy-side liquidity (stops over highs)"} at ${fx(ls.level)}, ${lastIdx - ls.index} candles ago, and closed back inside. That is a ${ls.direction} sign.` });
  }

  // 3. order blocks
  const obVis = obs.filter((o) => vis(o.candleIndex));
  if (obVis.length) {
    k++;
    badge(Math.min(X1 - 40, X(obVis[0].candleIndex) + 4 * slot), clampY(Y(obVis[0].top) - 20), k);
    items.push({ n: k, title: "Order blocks",
      text: obVis.map((o) => `${o.direction === "bullish" ? "Bullish" : "Bearish"} block ${fx(o.bottom)} to ${fx(o.top)} (${o.status === "unmitigated" ? "untouched" : "already tapped"}, ${pips(price > o.top ? o.top : o.bottom)} pips from price)`).join("; ") +
        ". Sky enters when price returns to a fresh block that agrees with the trend." });
  }

  // 4. fair value gaps
  const fvVis = fvgs.filter((f) => vis(f.index));
  if (fvVis.length) {
    k++;
    badge(X(fvVis[0].index) - slot - 16, clampY((Y(fvVis[0].top) + Y(fvVis[0].bottom)) / 2), k);
    items.push({ n: k, title: "Fair value gaps",
      text: fvVis.map((f) => `${f.direction === "bullish" ? "Bullish" : "Bearish"} gap ${fx(f.bottom)} to ${fx(f.top)}`).join("; ") + ". Price often returns to fill these gaps." });
  }

  // 5. liquidity targets
  const targets = [];
  for (const p of eqs) if (near(num(p.level))) targets.push({ tag: p.side === "buy" ? "EQH" : "EQL", level: num(p.level), text: p.side === "buy" ? "equal highs" : "equal lows" });
  for (const p of prevLevels) if (near(p.level)) targets.push({ tag: p.tag, level: p.level, text: p.tag === "PDH" ? "previous day high" : "previous day low" });
  if (targets.length) {
    k++;
    targets.forEach((t, i) => {
      const y = Y(t.level);
      out.push(`<line x1="${X0}" y1="${y.toFixed(1)}" x2="${X1}" y2="${y.toFixed(1)}" stroke="${C.amber}" stroke-width="2" stroke-dasharray="4 6" opacity="0.9"/>`);
      tag(y, `${t.tag} ${fx(t.level)}`, "#7a5a00");
      if (i === 0) badge(X0 + 40, clampY(y - 22), k);
    });
    items.push({ n: k, title: "Liquidity targets",
      text: targets.map((t) => `${t.text} at ${fx(t.level)}`).join("; ").replace(/^./, (ch) => ch.toUpperCase()) + ". Price is often pulled toward untouched liquidity like this, so Sky stops targets just before it." });
  }

  // 6. premium / discount
  if (rg && rg.eq !== null) {
    k++;
    const posPct = rg.high > rg.low ? Math.round(((price - rg.low) / (rg.high - rg.low)) * 100) : 50;
    badge(X1 - 40, clampY(Y(rg.eq) - 22), k);
    const where = posPct < 0 ? `Price has dropped below the range ${fx(rg.low)} to ${fx(rg.high)}` : posPct > 100 ? `Price has pushed above the range ${fx(rg.low)} to ${fx(rg.high)}` : `Price sits ${posPct}% up the range ${fx(rg.low)} to ${fx(rg.high)}`;
    items.push({ n: k, title: price >= rg.eq ? "Premium (expensive) half" : "Discount (cheap) half",
      text: `${where}. Sky only buys in the discount half and sells in the premium half, so ${price >= rg.eq ? "buys are blocked here" : "sells are blocked here"}.` });
  }

  // current price tag
  tag(Y(price), `NOW ${fx(price)}`, C.white, "#000");

  // 7. levels to watch (nearest key levels above and below price)
  const keyLevels = [];
  for (const o of obs) { keyLevels.push({ v: o.top, t: `${o.direction} order block top` }, { v: o.bottom, t: `${o.direction} order block bottom` }); }
  for (const t of targets) keyLevels.push({ v: t.level, t: t.text });
  if (rg) keyLevels.push({ v: rg.high, t: "range high" }, { v: rg.low, t: "range low" });
  const up = keyLevels.filter((x) => x.v > price).sort((x, y) => x.v - y.v)[0];
  const dn = keyLevels.filter((x) => x.v < price).sort((x, y) => y.v - x.v)[0];
  if (up || dn) {
    k++;
    items.push({ n: k, title: "Levels to watch",
      text: `${up ? `Above: ${fx(up.v)} (${up.t}, ${pips(up.v)} pips). A strong close over it shows buyers gaining strength.` : ""} ${dn ? `Below: ${fx(dn.v)} (${dn.t}, ${pips(dn.v)} pips). A strong close under it shows sellers gaining strength.` : ""}`.trim() });
  }

  // 8. what Sky is doing
  k++;
  items.push({ n: k, title: "What Sky is doing",
    text: `${verdict ? verdict : "No complete setup is visible right now."} Sky only marks a trade when the sweep, structure break and a fresh order block line up, in the right half of the range, inside the London or New York open.` });

  // ---- header ----
  const head = [];
  head.push(`<text x="30" y="62" fill="${C.text}" font-family="${FONT}" font-size="44" font-weight="700">${esc(sym)}</text>`);
  let px = 30 + sym.length * 29 + 18;
  const pill = (text, fill, fg = "#000") => {
    const w = text.length * 12.5 + 26;
    head.push(`<rect x="${px}" y="30" width="${w.toFixed(0)}" height="40" rx="10" fill="${fill}"/><text x="${(px + w / 2).toFixed(0)}" y="57" fill="${fg}" font-family="${FONT}" font-size="21" font-weight="700" text-anchor="middle">${esc(text)}</text>`);
    px += w + 10;
  };
  pill(String(tf || "").toUpperCase(), C.stroke, C.white);
  pill(`TREND ${String(a.trend || "unclear").toUpperCase()}`, a.trend === "bullish" ? C.up : a.trend === "bearish" ? C.down : C.stroke, a.trend === "neutral" || !a.trend ? C.white : "#000");
  head.push(`<text x="30" y="104" fill="${C.amber}" font-family="${FONT}" font-size="22" font-weight="700">MARKET MAP${htf ? `  ·  higher timeframe ${esc(htf)}` : ""}</text>`);
  head.push(`<text x="30" y="140" fill="${C.muted}" font-family="${FONT}" font-size="17">Green/red box = bullish/bearish order block  ·  Blue = gap  ·  Amber = liquidity</text>`);
  head.push(`<text x="30" y="172" fill="${C.muted}" font-family="${FONT}" font-size="16">${esc(`Last ${count} candles · ${String(tf || "").toUpperCase()} · prices to ${d} decimals`)}</text>`);

  const list = [];
  let y = Y1 + 56;
  list.push(`<text x="30" y="${y - 12}" fill="${C.text}" font-family="${FONT}" font-size="28" font-weight="700">How to read this chart</text>`);
  y += 22;
  for (const it of items) {
    const lines = wrap(it.text, 60);
    list.push(`<circle cx="46" cy="${y + 2}" r="16" fill="${C.amber}"/><text x="46" y="${y + 8}" fill="#000" font-family="${FONT}" font-size="19" font-weight="700" text-anchor="middle">${it.n}</text>`);
    list.push(`<text x="76" y="${y + 8}" fill="${C.text}" font-family="${FONT}" font-size="27" font-weight="700">${esc(it.title)}</text>`);
    lines.forEach((ln, i) => list.push(`<text x="76" y="${y + 44 + i * 32}" fill="${C.muted}" font-family="${FONT}" font-size="24">${esc(ln)}</text>`));
    y += 44 + lines.length * 32 + 26;
  }
  y += 6;
  list.push(`<text x="30" y="${y + 10}" fill="${C.muted}" font-family="${FONT}" font-size="16">Built from real candles and Sky's own analysis, drawn ${esc(eat(now))}. For education only, not financial advice.</text>`);
  const H = Math.ceil(y + 44);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" preserveAspectRatio="xMidYMin meet">` +
    `<rect width="${W}" height="${H}" fill="${C.bg}"/>` + head.join("") + out.join("") + labels.join("") + badges.join("") + list.join("") + `</svg>`;
}
