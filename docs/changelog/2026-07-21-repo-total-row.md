# Live cards show repo's all-time cumulative totals

Live cards now show the repo's all-time cumulative total (prompts + tokens + cost) as a second row aligned
under the per-session stat columns — each value sits under its matching per-session number, so the two
rows compare straight down. It carries NO text label: the muted colour + dashed divider mark it as the
repo total (tooltip explains). Ends the "is this a bug?" reaction from comparing one session's numbers to
the larger per-repo total (different scopes: one session vs. all sessions + backfill).
Served as a `repoTotals` map on `/api/state`, aggregated via a shared `aggregateReposAcrossDates` helper
(also used by History, so they can't diverge) and MEMOIZED — `buildStatePayload` is on the SSE broadcast
hot path, so it must not re-scan the log dirs each frame; the cache clears on any token/rollover/prune/
cost-config change. Figure is all-time but bounded by `retentionDays` (disclosed in the tooltip), not
tied to the Per-repo view's range filter.
Known limits: all-time PROMPTS count live turns only — backfill imports tokens/cost but no turn count, so
it under-represents repos with imported history; and cost uses `estimateCost().total` (like every other
cost figure), silently omitting unpriced/unknown models — uniform partial-cost disclosure is deferred.

<!-- entry 9 -->
