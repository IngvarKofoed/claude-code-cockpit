# Active time redefined as engaged wall-clock everywhere

Active time redefined as ENGAGED wall-clock and made consistent across every view (live card, per-repo,
History). A session accrues active time while `running` OR with a subagent/workflow in flight, and NOT
while `waiting` on a permission prompt or idle. So it now EXCLUDES permission/idle waits and INCLUDES
background-workflow time (a `Workflow`'s `workflow-subagent` hooks arrive on the parent session after the
launching turn's Stop). Chosen over the old turn-duration because raw turn wall-clock counted lunch-break
permission waits and missed background work the user is really waiting on.
Now derived from the EVENT LOG via an incremental engaged clock (`aggregate.applyEvent`'s `engagedSince`),
not from turn `durationMs` (that field is dropped from new usage records). The live per-session `activeMs`
and the per-repo/day rollup + by-hour histogram all run the SAME `applyEvent` replay
(`accumulateActiveFromEvents`), so they can't diverge, and because active time is a pure function of the
durable, replayed event log it is crash-safe with no separate persistence (a restart re-derives identical
values — verified). The engaged clock is hardened against a missing/unparseable ts (stops the clock rather
than later settling the idle gap) and a backward/out-of-order ts (never re-anchors backward).
Limits: a background `Bash` (`run_in_background`) spawns no subagent so its time can't be seen; backfilled
history has no events so contributes tokens/cost but no active time; a span still engaged across midnight
loses the slice between its last pre-midnight and first post-midnight event (the clock is reset at day
rollover so the live and re-derived figures agree rather than diverge). Known transient boot-window edge:
the live per-session `activeMs` can briefly disagree with the rollup right after a restart in narrow cases
(an event appended during the boot read window; a same-day upgrade from a pre-clock v0.4.0 snapshot with no
`engagedSince`; a boot straddling local midnight) — it self-corrects on the next restart's re-derivation,
and fully unifying the snapshot-fast-start and event-rescan paths is a deferred follow-up.

<!-- entry 14 -->
