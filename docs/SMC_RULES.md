# SKY AI SIGNALS - SMC engine rules (smc-0.1.0)

All rules run on CLOSED candles only. The forming candle is never analysed.
All thresholds live in `src/smc/config.js`. Output is analytical information, not trade advice.

## No look-ahead
Every detection records the candle index at which it became knowable. Swings are confirmed
`swingRight` candles after they form. A test (`NO LOOK-AHEAD`) re-runs the engine on truncated
history and requires identical detections.

## Rules
- **ATR**: Wilder ATR, period 14. Thresholds for candle i use ATR of candle i-1 (never the candle itself).
- **Swing high**: high strictly above the 3 previous highs and at least as high as the 3 following highs. Swing low mirrors it. Confirmed 3 candles later.
- **HH / HL / LH / LL**: each confirmed swing is compared with the previous swing of the same type.
- **BOS**: a candle CLOSES beyond the most recent unbroken swing, in the direction of the current trend (or the first break from neutral).
- **CHOCH**: a candle CLOSES beyond the most recent unbroken swing against the current trend. Wicks never count. Each swing breaks once.
- **Liquidity pool**: buy-side above swing highs, sell-side below swing lows.
- **Equal highs/lows**: two same-type swings within 0.1 x ATR with no candle pushing beyond them in between.
- **Liquidity sweep**: after the swing is confirmed, a candle wicks through the level by at least 0.05 x ATR and closes back on the original side. A close beyond the level is a break, not a sweep.
- **Displacement**: body >= 1.5 x ATR(previous) and body >= 60% of the candle range.
- **FVG**: bullish if low(c3) > high(c1); bearish if high(c3) < low(c1); height >= 0.1 x ATR. Status: unmitigated, partially_mitigated, filled.
- **Order block**: last opposite-colour candle (within 5) before a displacement candle that falls within 3 candles before a BOS/CHOCH close, located after the swing that was broken. Zone = that candle's high-low. Confirmed at the break candle. Status judged only from later candles: unmitigated, mitigated, invalidated (close through the far side).
- **Dealing range / premium-discount**: latest confirmed swing high and swing low, at least 1 x ATR tall. Above the midpoint is premium, below is discount.
- **Sessions** (fixed UTC, no daylight saving): Asia 00-07, London 07-16, New York 12-21. Session ranges need timeframes of 1 hour or less.
- **Previous day**: UTC calendar day whose candles span at least 12 hours. **Previous week**: week starts Sunday 22:00 UTC.
  `complete=false` means the loaded candles do not reach back to the start of that period.

## Known limitations
- Session hours and the day boundary are approximations; real FX sessions shift with daylight saving.
- Only the 300 most recent candles are loaded, so previous-week levels need H1 or H4.
- Tick volume (provider supplied) is not used by any rule.
