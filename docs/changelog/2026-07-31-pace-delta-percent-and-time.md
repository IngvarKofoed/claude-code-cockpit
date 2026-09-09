# Pace delta shows both percentage and time gap

The Live usage bars' pace delta now shows BOTH the percentage AND time — "▲ 5% · 21m ahead" /
"▼ 22% · 1d 13h behind" / "on pace" (was percentage only, "▲ +8%") (v0.16.0). The % is the gap in
percentage points (usedPct − elapsedFrac×100), the time is that SAME gap × window length — legible units
esp. on the weekly bar where a bare % gap was hard to feel (a +22% reads as "1d 13h ahead"). Both are the
fill-vs-tick gap the tick already shows, so no new information — just readable. Minute resolution (no
seconds); a gap within a RELATIVE on-pace band (~0.5% of the window, floored at 60s) reads "on pace" —
relative so the 7d bar keeps a ~50min band, not a fixed 60s it would never hit. `usagePace`/tick/
fill-colour/reset-line all unchanged. Chose this linear rescale over a burn-rate exhaustion projection
("you'll run out X early"), which is more actionable but jumpy early in a window — deferred, not rejected.

<!-- entry 52 -->
