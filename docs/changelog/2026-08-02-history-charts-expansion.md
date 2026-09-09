# History view expands to fifteen charts plus a pivot

History view expanded from 4 charts to 15 in four families — Time-series, Distributions, Rhythm,
Efficiency ratios — plus an interactive PIVOT (one stacked chart re-decomposed live by Measure ×
Group-by × Normalize). Spec: docs/specs/2026-07-08-history-charts-expansion.md (v0.19.0).
One enriched `/api/history?range=` payload feeds all of it: each `perDay` now carries per-group
breakdowns (`byModel` {tokens,cost}, `byRepo`, `byTool`, `byAgentType`, `costByType`) + scalars
(prompts/sessions/tools/subagents), and a top-level `byDowHour` 7×24 matrix REPLACES `byHour`. The
pivot re-slices this in the browser — only a range change refetches. History stays off the SSE path.
New rollup field `byAgentType` (event-derived from `SubagentStart.agent_type`, same unconditional
pattern as `byTool`/`subagents`) — added on BOTH the live handleEvent branch and the boot rescan, else
today's per-type breakdown lags until restart. Per-day per-model AND per-token-type cost are priced
server-side; the day's combined map is priced ONCE and reused (dropped the redundant `dayCost`).
`byDowHour`/calendar weekday is computed LOCAL (new Date(y,m-1,d)), never `new Date(str)` (UTC-shifts).
The pivot is HONESTY-CONSTRAINED (measure-led): only attributable Measure×Group cells are selectable —
active/chats aren't attributable to a model/tool, tokens/cost aren't attributable to a tool/agent — so
an unbacked cell is absent, never a wrong zero; a group invalid under the current measure falls back to
Repo. Overflow past 6 series folds into a muted "Other" slice.
`charts.js` gained `stacked` (opt `normalize`=100% share), `grouped`, `donut`, `punch` (day×hour,
generalizes+replaces `hourHeatmap`), `calendar` (caller must Monday-align the days); `styles.css` gained
the validated categorical tokens `--series-3..6`. Distributions/ratios are pure client-side sums/ratios
of `perDay` (cache efficiency, burn rate, tokens/chat — divide-by-zero guarded); cost-dependent charts
show an empty state when cost display is off.
Known limit: live in-browser render/interaction was NOT verified this session (Chrome extension
disconnected); verified via 147 unit tests, a sandboxed daemon `/api/history` end-to-end check, and a
DOM-shim run of every chart primitive.

<!-- entry 57 -->
