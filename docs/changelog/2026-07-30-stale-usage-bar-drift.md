# Stale usage bar keeps drifting instead of dimming

A stale usage bar (>10 min since the last statusline push) is no longer DIMMED — instead it keeps its
fill + a live-drifting pace cue and shows a now-legible "updated Xm ago" note (bumped ink-muted→ink-2) as
the sole "old data" signal. The pace tick/delta keep advancing on a stale bar: usedPct is frozen but
elapsed grows, so the over-pace amber delta walks down toward/under 0 over time until reset — which is the
intended pace reading, not a bug. This DELIBERATELY reverses entry 42/44's freeze-on-stale (the earlier
code-review "don't drift a wrong under-pace" fix): per the user, the drift IS the desired behavior and the
age note flags the staleness, so do NOT re-freeze it. `reset`/`nodata` bars stay dimmed (no live fill).

<!-- entry 46 -->
