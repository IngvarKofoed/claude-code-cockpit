# ETA replaced by a burn-rate multiplier

Both Live usage bars REPLACED the time-left ETA (entry 53's "≈2h left") with a burn-rate MULTIPLIER
riding after the pace delta in the foot ("▲ 5% · 12m ahead   2.5×") (v0.18.0) — current velocity as a
multiple of the even "normal" rate that lands on exactly 100% at reset, so 1.0× is on pace, 2.5× is 2.5×
that. `m = usedFrac / elapsedFrac`, via a new `applyMult` (render+tick single impl, mirroring applyDelta).
Chosen over the ETA countdown because a rate reads as inherently variable — an early swing looks like
"going fast now", not the ETA's alarming, jumpy-early "you'll run out in 2d" against a small lead early in
a 7d window (the contradiction that prompted the swap). `applyEta` and its `.usage-bar__eta` styles are
removed.
Coloured by the SAME rounded value it DISPLAYS (over→amber, under→green, on→muted), so the number and its
colour can never contradict — a shown "1.0×" is always the muted on-pace colour, "1.1×"+ over, "0.9×"−
under. This is a RATIO verdict, deliberately NOT the delta's additive time-gap verdict: near a window's
START a small absolute gap is a large ratio, so the multiplier can read over/under while the delta still
reads on-pace — the ratio is the intended earlier signal there. (Colouring by the gap would paint a
rounded "1.0×" amber mid-window and a far-from-1× ratio muted early — the number fighting its own colour.)
Blank in a jumpy-early guard (window's first 1% / under 1% used); at the cap (pct≥100) it shows "at limit"
(error colour) — with the ETA gone the multiplier is now the sole exhausted-state cue. On a stale bar it
drifts down (entry-46 no-re-freeze). Gated on `usagePace` (shown for `both`/`delta`), travelling with the
delta. The head is unchanged (label + %); the multiplier lives entirely in the foot.

<!-- entry 54 -->
