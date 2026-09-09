# Multiplier absorbs pace delta's styling and settings label

Consequences, all load-bearing: the multiplier inherits the `margin-left: auto` that right-aligned
the group, and LOSES its leading "· " (that joined it to the delta; alone it would dangle off
"2.0×"). `usagePace` keeps its stored values so nothing migrates — "delta" now means "readouts",
relabelled in Settings as "Tick + readouts" / "Readouts only". `applyDelta` is deleted;
`fmtPaceGap` survives for applyLimit's shortfall tooltip.

<!-- entry 158 -->
