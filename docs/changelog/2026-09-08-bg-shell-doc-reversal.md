# Doc corrected: background shell excluded from active time

That REVERSES entry 25's deliberate "a run_in_background Bash now counts as active" bonus.
ARCHITECTURE.md claimed the opposite, so the doc was stale, not prescient — it now states
the exclusion as a choice. Accepted costs: a genuine background BUILD contributes no active
time on its own, and the "N in flight" chip shows only on a running card, so a shell-only
session shows none. `bgAgents == null` (older `emit.js` / events) falls back to `bg_tasks`.

<!-- entry 205 -->
