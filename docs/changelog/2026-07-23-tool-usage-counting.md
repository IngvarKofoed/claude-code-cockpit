# Tool usage is now counted per session and repo

Tool usage is now counted. Per session: `session.toolCount` increments on every `PreToolUse`
(num()-guarded for snapshot restore), including subagent tool calls (they fire on the parent session_id).
Per repo: a new event-derived `byTool` rollup tallies `PreToolUse` by tool name — UNCONDITIONALLY, on its
own branch, NOT gated on the active clock's `activeDelta>0` (else midnight/idle-start calls would drop and
live-vs-rescan would diverge) — exposed on `/api/state` repos and `/api/history` topRepos, and shown as a
sortable "Tools" column (with a per-tool breakdown tooltip) on the Per-repo page. Like active time, byTool
is event-derived, so backfilled/event-pruned days show Tools 0.

<!-- entry 17 -->
