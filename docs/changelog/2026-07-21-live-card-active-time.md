# Live cards show session's cumulative active time

Live cards now show "Active" — a session's cumulative working time (Σ closed-turn durations,
`session.activeMs`, added on Stop/StopFailure), distinct from the wall-clock Age beside it. The muted
repo-total row gains the repo's all-time active time too, and cards widened to fit the extra column.
Like prompts, activeMs counts live turns only — backfill can't reconstruct turn boundaries — so it
under-represents repos with imported history.

<!-- entry 11 -->
