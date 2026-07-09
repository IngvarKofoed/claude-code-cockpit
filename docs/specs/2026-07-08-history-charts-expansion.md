# History view chart expansion + pivot control layer

Grow the History view from four charts to fifteen, organized into four families
(Time-series, Distributions, Rhythm, Efficiency ratios), plus an interactive
**pivot** — one stacked chart driven by Measure × Group-by × Normalize controls.
All of it is fed by **one enriched `/api/history?range=` payload**: each `perDay`
entry gains the per-group breakdowns every chart (and the pivot) needs, so the
pivot re-slices in the browser with no refetch. The only genuinely new stored
data is a `byAgentType` rollup field; everything else is re-shaped from data the
rollups already hold. The gallery mockup's chart functions become the real
`charts.js` primitives.

## Key decisions

- **One enriched `/api/history` payload** (extends). Keep the single
  `?range=` endpoint; fatten each `perDay` entry with per-group breakdowns
  (`byModel`, `byRepo`, `byTool`, `byAgentType`, and scalar
  `prompts`/`sessions`/`tools`/`subagents`). The client renders all 15 charts and
  re-slices the pivot from this one fetch. History is request-scoped (never on the
  SSE broadcast path), so payload size doesn't touch live updates. The Repos view
  reads only `topRepos`, so it is unaffected.
- **`byAgentType` rollup field** (extends). The only new stored field. Tallied
  from `SubagentStart.agent_type` (already captured by `emit.js:97`) in
  `aggregate.accumulateActiveFromEvents`, on its own unconditional branch exactly
  like the existing `byTool` and `subagents`. Event-derived, so backfill-only /
  event-pruned days show empty — consistent with those siblings.
- **Per-day cost, server-priced by model and token type** (reuses). Each
  `perDay.byModel[model]` carries `tokens` and a `cost`, and each day also carries
  a `costByType` split across the four token classes — all priced server-side from
  the config rates (as `dayCost` already does), so the client never needs the rate
  table. `costByType` is what powers the pivot's Cost × Token-type view.
- **Punchcard is derived, not stored** (reuses). A rollup day already has
  `hourActive[24]` and *is* one weekday, so the 7×24 matrix is built at request
  time by grouping each day's hour strip under its weekday. No new rollup field, no
  extra event scan. **The weekday must be computed in local time** (parse the
  `YYYY-MM-DD` date as a local calendar date — `new Date(y, m-1, d).getDay()`, not
  `new Date(dateStr)`, which parses as UTC and shifts the weekday in any non-UTC
  zone) — because the rollup's dates and its `hourActive` hours are both local.
- **Distributions and ratios are client-side** (new). Cost-by-model, tool usage,
  subagents-by-type, and model share are sums of the `perDay` breakdowns; cache
  efficiency, burn rate, and tokens-per-chat are ratios of `perDay` fields. No new
  range-aggregate server code.
- **Honesty-constrained, measure-led pivot** (new). The data can't attribute every
  measure to every group, and the cockpit never shows a wrong number. The pivot
  picks a Measure, then offers only the Groups that measure can honestly attribute
  (matrix in Design); invalid combinations are never selectable. Measure / Group /
  Normalize are pure client re-slices; only a Range change refetches.
- **Chart primitives ported from the gallery** (extends). `stacked` (with a
  `normalize` flag), `grouped`, `donut`, `punch` (a 2-D generalization of the
  existing `hourHeatmap`), and `calendar` join `charts.js`, following its existing
  conventions (`viewBox` W=640, `styleTicks`, `bindTip`, `emptyState`). The
  palette was already validated against the dark surface during the gallery.
- **Add `--series-3..6` design tokens** (new). `styles.css` defines only
  `--series-1/2`; the validated categorical set needs four more
  (`#c98500`, `#e66767`, `#9085e9`, `#008300`).
- **History view reorganizes into four families** (diverges). The current flat
  four-chart grid becomes the four labelled families + the pivot. The
  activity-by-hour heatmap is superseded by the day×hour punchcard, and
  `byHour` is replaced by `byDowHour` in the response.

## Goals

- Ship all 15 gallery charts in the History view, grouped into the four families.
- Ship the pivot control layer (Measure × Group-by × Normalize over the view's
  range), honest to what the data can attribute.
- Reuse the validated gallery chart code as the `charts.js` implementation.
- Keep History off the SSE hot path; add no new persisted store.
- No wrong numbers: an unattributable measure×group cell is *absent*, never a
  misleading zero.

## Non-goals

- No new persisted store or SQLite — JSONL rollups are unchanged except for the
  additive `byAgentType` field.
- No changes to the live/SSE `/api/state` payload, the Repos table columns, or the
  Sessions view.
- No per-day-per-group capping (Top-N + "Other") in the payload in v1 — the full
  payload is accepted (see Resolved decisions). (The pivot still folds an overflowing
  group's tail into an "Other" *slice* client-side; that's a rendering cap, not a
  payload cap.)
- No transcript / message content — the privacy boundary is untouched.

## Design

### Enriched `/api/history?range=` (daemon.js `buildHistory`)

Today it returns `{ range, perDay[], byHour[], topRepos[] }`. `topRepos` stays
(the Repos view depends on it). `byHour` is replaced by `byDowHour`. Each
`perDay` entry grows from `{ date, tokens, activeMs, cost }` to:

```jsonc
{
  "date": "2026-07-08",
  "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, // existing
  "cost": 0,          // existing (dayCost)
  "costByType": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 }, // new (per-token-type cost)
  "activeMs": 0,      // existing
  "prompts": 0, "sessions": 0, "tools": 0, "subagents": 0,   // new scalars (Σ repos that day)
  "byModel":     { "<model>":    { "tokens": { … }, "cost": 0 } },        // new
  "byRepo":      { "<repoRoot>": { "repoName": "…", "tokens": { … },
                                   "cost": 0, "activeMs": 0, "prompts": 0,
                                   "tools": 0, "subagents": 0 } },         // new
  "byTool":      { "<tool>": 0 },        // new
  "byAgentType": { "<type>": 0 }         // new
}
```

Plus one top-level field: `byDowHour` — a `7×24` matrix of active ms
(`[weekday][hour]`), built by iterating the range's dates and folding each day's
existing `hourActive[24]` into `matrix[weekday]`, where `weekday` is the date's
*local* day-of-week (see the Punchcard key decision — parse as a local date, not
`new Date(dateStr)`).

`buildHistory` already loops `getRollup(date).repos`; the enrichment re-shapes
that same per-repo rollup data (tokens, byModel, byTool, subagents, prompts,
sessions, activeMs) into the per-day maps and prices `byModel`/`byRepo` cost with
`pricing.estimateCost`. `costByType` is priced per token class by summing, over
each priced model, `tokens[class] × rate[class]` (unpriced models omitted, exactly
as `estimateCost` handles them). When `cfg.cost.enabled` is false, every `cost`
field is `null` (as `dayCost` already returns).

### `byAgentType` (aggregate.js)

- `ensureRepo` gains `byAgentType: {}`.
- In `accumulateActiveFromEvents`, add a branch mirroring the `subagents` tally:
  on `SubagentStart` with `event.agent_type`, `repo.byAgentType[type] =
  num(...) + 1`. Unconditional (not gated on the active clock), same as `byTool`.
- `aggregateReposAcrossDates` (which builds `topRepos`) needs **no** `byAgentType`
  change for v1 — nothing consumes a per-repo range aggregate of it (the
  subagents-by-type chart sums `perDay.byAgentType` client-side). Deferred until a
  consumer exists, to avoid speccing unused work.

### charts.js primitives

Port the gallery's functions, adapted to `charts.js` conventions:

| Primitive | Used by |
|---|---|
| `stacked(host, cats, series, {normalize})` | tokens-by-type, cost-by-model, active-by-repo, **the pivot** |
| `grouped(host, cats, series)` | chats & sessions per day |
| `donut(host, slices)` | model share |
| `punch(host, matrix7x24)` | day×hour punchcard |
| `calendar(host, dayVals)` | calendar heatmap |

`lineChart` (cost/day, cumulative, the three ratios) and `barChart` horizontal
(cost-by-model, tool usage, subagents-by-type) are reused as-is. Mark specs from
the gallery hold: 2px surface gaps between stacked segments, a legend whenever
≥2 series, single-hue for magnitude rankings, hover on every mark. `hourHeatmap`
is removed once the punchcard replaces its only caller.

### View layout (index.html + app.js `drawHistory`)

Four `<section>` families, each a `.charts` grid of `.chart-card`; the existing
`histRange` filter (today / 7d / 30d / all) governs the whole page.

- **Time-series** — Cost/day (line) · Tokens/day by type (stacked) · Cost/day by
  model (stacked) · Active/day by repo (stacked) · Cumulative cost (line) ·
  Chats & sessions/day (grouped).
- **Distributions** — Cost by model (hbar) · Tool usage (hbar) · Subagents by
  type (hbar) · Model share of tokens (donut; matches the gallery — the donut is a
  token-share view, distinct from the Cost-by-model bar beside it).
- **Rhythm** — Day×hour punchcard (full-width) · Calendar heatmap (full-width).
- **Efficiency ratios** — Cache efficiency (line, %) · Cost per active hour
  (line) · Tokens per chat (line).

`drawHistory(h)` stashes `h` in `App.histData` and renders every chart from it.
Distributions sum `perDay.by*`; ratios divide `perDay` fields with a
divide-by-zero guard (a day with 0 active time / 0 chats renders no point, not
`Infinity`). Cost-dependent charts render an empty state when `cfg.cost.enabled`
is false.

### The pivot

A toolbar (Measure segmented control · Group-by segmented control · Normalize
toggle) above one `stacked` chart. Attributable combinations only:

| Group ↓ / Measure → | Tokens | Cost | Active | Chats | Tools | Agents |
|---|:-:|:-:|:-:|:-:|:-:|:-:|
| **Repo** | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| **Model** | ✓ | ✓ | — | — | — | — |
| **Token type** | ✓ | ✓ | — | — | — | — |
| **Tool** | — | — | — | — | ✓ | — |
| **Agent type** | — | — | — | — | — | ✓ |

Measure-led: choosing a Measure repaints the Group control to only its valid
groups (Repo is always valid). If the currently selected group is invalid under
the newly chosen measure (e.g. Model selected, then Measure switched to Active),
the selection falls back to Repo. The stacked series come from re-slicing
`App.histData.perDay` by the chosen group — e.g. Cost × Token-type reads
`perDay.costByType`, Tokens × Token-type reads `perDay.tokens`, Active × Repo reads
`perDay.byRepo[*].activeMs`. `normalize` flips absolute ↔ 100% share. All three
controls re-render client-side; the pivot shares the page's range, so no control
here triggers a refetch. When a group has more entries than
the categorical palette (repos especially), the tail folds into an **"Other"**
slice so totals stay honest and colors never cycle.

### styles.css

Add `--series-3: #c98500; --series-4: #e66767; --series-5: #9085e9;
--series-6: #008300;` to `:root`. (The gallery validated this set on the
`#141922` surface; the green↔yellow floor-band adjacency is mitigated by the
legend + direct labels + 2px segment gaps, per the dataviz relief rule.)

## Resolved decisions

Settled at hand-off (defaults accepted except cost-by-type):

- **Pivot range:** shares the page-level `histRange` — one range for the page keeps
  every pivot toggle refetch-free. A per-pivot range can come later.
- **Payload capping:** none in v1 — History is request-scoped and off the SSE path,
  so a fat payload is acceptable; revisit only if the "all" range gets slow on a
  store with many repos (Top-N + "Other" is the fallback).
- **Cost by token type:** *included* — `costByType` ships in the payload and the
  pivot offers Cost × Token-type (output dominates cost, so it's worth seeing).
- **Tokens by hour:** dropped — `byHour` is replaced by `byDowHour`; tokens-by-hour
  was only ever an input to the superseded hour heatmap and was never charted.

## Alternatives considered

- **Server-shaped series per request** (`?range=&measure=&group=`). Leaner
  payloads, but every pivot toggle refetches (laggy), and it adds param/endpoint
  surface that diverges from the single-payload pattern. Rejected — the pivot's
  responsiveness is the point.
- **Split endpoints** (fixed charts on `/api/history`, pivot on
  `/api/history/pivot`). Duplicates aggregation and still refetches on toggle.
  Rejected for the same reason.
- **Full Measure × Group cross-product pivot.** Simpler UI, but invalid cells
  (active-by-model, tokens-by-tool) would render blank or zero — a wrong number by
  omission, against the cockpit's honesty principle. Rejected in favor of the
  constrained matrix.
