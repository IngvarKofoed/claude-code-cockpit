# Sliding lookback changes the multiplier's reference rate

Under a sliding lookback ONLY, the multiplier's reference becomes what the REMAINING budget
sustains — `rate / ((100−used)/timeToReset)` — so 1.0× means "on track to finish at 100%"
and `m > 1` is algebraically "the projection lands before the reset" — for the RAW ratio.
The displayed multiplier is rounded and the clause is not, so a true 1.02x still shows a
muted "1.0x" beside an amber "limit in ~3h": entry 159's accepted trade, not removed here. The 5h bar and Week keep `usedFrac/elapsedFrac` untouched:
the cost is that 1.0× means two things depending on the bar, carried by the tooltip.

<!-- entry 164 -->
