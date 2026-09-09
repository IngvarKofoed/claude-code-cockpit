# Post-review fixes to the History rewrite

Post-review fixes to the History rewrite (v0.20.0):
- Calendar heatmap now builds a CONTIGUOUS daily series (the first day's Monday → the last day,
  missing days = 0) before layout. It placed cells by array index assuming perDay was contiguous, but
  the "all" range omits inactive days — so the first gap shifted every later day into the wrong
  weekday/week. Confirmed user-facing correctness bug.
- `lineChart` x-axis labels now iterate the LONGEST series' points (not `series[0]`), so labels can't
  compress/mislabel if a caller ever passes a shorter first series (latent; not hit by current callers).
- `barChart` reads `opts.fmt || opts.format` (was format-only), unifying the formatter key with the
  other primitives so a direct `{fmt}` caller isn't silently defaulted to `commas`.
- Removed dead code: the unused `grouped`/`donut` primitives (no caller after the flat rewrite) and a
  stale index.html comment referencing the removed families/pivot.
Skipped (deliberate, not a bug): buildHistory still emits unread per-day `byModel`/`byRepo` — entry 61
keeps every breakdown re-addable, and it's off the SSE hot path.

<!-- entry 62 -->
