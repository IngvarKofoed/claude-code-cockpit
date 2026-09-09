# Full-width dual-axis tokens-and-cost-per-day chart added

New "Tokens & cost per day" chart at the top of the History view (above the families): a FULL-WIDTH card
with the title inside it (above the graph), no subtitle, the chart filling the card width and 50% taller
than a normal card (height 360 vs the 240 default) (v0.20.0). Two lines,
DUAL-AXIS: tokens on the left axis, cost on the right, each scaled to its
OWN range so both fill the plot and sit close; axis tick labels are colour-matched to their line and the
tooltip shows both real values. Dual-axis is a deliberate, user-chosen tradeoff over the honest one-axis
default (indexed %) dataviz prefers — the two scales are independent, so the crossing point carries no
meaning (noted at the call site + in charts.js).
`lineChart` now renders TWO series as this dual-axis chart (per-series scale/fmt/colour, left+right axes,
legend, one crosshair dot per series); ONE series is unchanged (single axis, area wash, no legend).
The History card grid became an explicit 12-column layout (normal card spans 4 = 1/3, `half` 6 = 1/2,
`wide` the full row; collapses 2-up ≤1100px then 1-up ≤680px), replacing the auto-fill minmax(340px) grid
so a card can be sized to a fraction of the row.

<!-- entry 58 -->
