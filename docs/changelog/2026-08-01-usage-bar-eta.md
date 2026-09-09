# Usage bars gain a time-left-at-velocity ETA

Both Live usage bars now carry a "time left at current velocity" ETA after the pace delta (v0.17.0) —
the burn-rate exhaustion projection deferred in #52, now shipped. Simple linear velocity:
timeLeft = ((1 − usedFrac) / usedFrac) × elapsed. Over pace → "≈3h left" (amber) with the shortfall in
the tooltip; under pace → "won't run out" (muted, no huge number in text OR tooltip); on pace → the
reset-sized "≈X left" muted (not a warning). The over/under/on verdict is decided by the SAME signed gap +
`paceTolerance` band the delta uses — NOT a bare timeLeft<timeToReset boundary, which would fire amber
while the delta beside it still read "on pace" (the two cues on one bar must agree). Sub-60s renders
"<1m left" (fmtPaceGap floors to minutes, so it would otherwise read "≈0m left"). Gated to a settled
reading — blank under ~1% used or in the window's first 1% elapsed, where the projection swings wildly
(the #52 "jumpy early" caveat). On a STALE bar it keeps drifting in lockstep with the delta (per the
entry-46 no-re-freeze rule; the age note flags staleness). Rides alongside the delta, gated on the same
`usagePace` (shown for `both`/`delta`); advances every second on the shared tick loop via `applyEta`, the
render+tick single implementation mirroring `applyDelta`.

<!-- entry 53 -->
