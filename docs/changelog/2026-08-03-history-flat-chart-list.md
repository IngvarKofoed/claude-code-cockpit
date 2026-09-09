# History pared to a flat eight-chart list

History view pared to a FLAT, full-width list of 8 charts — no grouping, headers, or pivot (v0.20.0):
Tokens & cost per day · per active hour · Tokens per chat · Cost per day by type · Day-of-week × hour ·
Calendar heatmap · Subagents by type · Tool usage.
The three "Tokens & …" line charts are DUAL-AXIS (tokens left, cost right, each self-scaled) with quiet
DOTTED, axis-less correlation lines — Chats + Avg context on the per-day/per-hour ones, Tools + Active on
per-chat — read for shape, real values in the tooltip. `lineChart` gained per-series `noAxis` (a
self-scaled line with no tick axis) and `dash`/`dot` styling; `avgContext` = (input+cacheRead+cacheWrite)
/chats (prompt-side tokens per turn, an estimate).
Cost-by-type REPLACED tokens-by-type: token counts are ~all cache-read (a flat one-band chart), but COST
splits meaningfully because output is ~50× cache-read per token — so the cost split is where the signal
is for single-model, cache-heavy usage.
REMOVED as low-signal for that usage: the Measure×Group pivot, the family grouping, and the small
distribution/efficiency charts (cost/day, cost-by-model, active-by-repo, cumulative cost, chats&sessions,
model share, cache efficiency, cost/active-hour) — model/token breakdowns are trivial with one model and
cache-efficiency sits at ~100%. The daemon still emits every breakdown, so they're re-addable.
`barChart` now auto-sizes its label gutter to the longest category name (capped) and takes an optional
per-bar `%`-of-total; `barChart`/`stacked` (like `lineChart`) render at the card's real pixel width.

<!-- entry 61 -->
