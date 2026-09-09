# Live ribbon becomes a today-at-a-glance summary

The Live ribbon is now a "today at a glance" summary (Live is the main screen). Sessions, Agents, and
Active time are TODAY's totals summed from the today per-repo rollup (`App.state.repos`), not sums over
only the live sessions — so a session that already ended today still counts. Only Running / Waiting stay
momentary (status counts over the live set). "Active agents"→"Agents" (now Σ today's `subagents`, not the
in-flight `bgTasks`), and the "today" postfix dropped from Tokens/Cost since the whole ribbon is now today.
Sessions/Agents sum per-repo counts, so a session spanning two repos counts once per repo (rare; matches
the Repos table). The ribbon reads `r.sessions` as array-or-number (mirroring `normalizeRepoRow`) so it and
the Repos table can't disagree on a stale payload. Known edge: a session live but idle since before midnight
logs no event today, so it's absent from today's rollup — its card still shows but it isn't in the Sessions
count (the inverse of an ended-today session, which does count).

<!-- entry 38 -->
