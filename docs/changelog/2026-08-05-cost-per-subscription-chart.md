# Subscription bars become a cost-per-day line chart

History subscription chart reworked (v0.24.0): the "Tokens & cost per subscription" BARS became a
"Cost per subscription" LINE chart — one line per subscription over days (shared $ axis, tokens in
tooltip), moved up under "Tokens & cost per day". `buildHistory` now emits a priced per-day
`bySubscription` on each `perDay` (was top-level range-aggregate only); `lineChart` gained `sharedScale`
(N same-unit lines, one axis + legend, no area wash) + per-point `value2`/`fmt2`. >6 subs fold to "Other".

<!-- entry 71 -->
