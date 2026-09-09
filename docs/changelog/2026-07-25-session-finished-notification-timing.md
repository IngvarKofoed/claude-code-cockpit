# Session-finished notification now fires on real completion

The "session finished" OS notification and the "done" card pulse/sound now fire on the real engaged→idle
transition (aggregate's `disengagedNow`) GATED on the settled status being `idle` — not merely on Stop. So a
handoff Stop with background work in flight stays silent, a permission prompt (running→waiting) fires only
needsInput, and "finished" lands at real completion. Since a background workflow's last subagent leaves status
`running`, the event that empties `background_tasks` first settles that residual `running`→idle (when no
foreground turn is open) so completion actually registers. Client pulse/sound key off the same
`effectiveStatus`, so visual, sound and OS notification agree.
Known limit: a DROPPED SubagentStop leaves the session "engaged" (a lingering "working" timer, no finished
ping) until the next turn's Stop re-reports the count — bounded and self-healing, unlike the old counter's
permanent drift.

<!-- entry 26 -->
