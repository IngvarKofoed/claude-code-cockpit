# Weekly usage bar gains the same pace cue as 5h bar

The weekly (7d) usage bar now carries the SAME pace cue (tick + delta) as the 5h bar, governed by the
existing `usagePace` setting — one control now applies to BOTH bars (Settings label generalized from
"5h usage pace cue" to "Usage pace cue"). Reverses entry 42's "5h only" scope. Cheap because the cue
machinery was already per-window (elapsedFrac over each bar's windowMs); the weekly bar simply stopped
being hard-passed "off". A 7-day pace line moves slowly (rarely the thing you react to), kept for consistency.

<!-- entry 44 -->
