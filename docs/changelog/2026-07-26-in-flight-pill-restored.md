# In-flight pill restored on live card via bgTasks

Restored the live in-flight pill on the Live card (dropped in entry 16 for the cumulative Agents stat):
green with a pulsing dot, next to the model/effort chips, shown ONLY on a running card while bgTasks>0
(suppressed on waiting/error, where a green pulse would misread as progress). Sourced from Claude Code's
authoritative background_tasks count (bgTasks), NOT subagents.active (dropped-SubagentStop drift
over-reports). Labelled "N in flight" — bgTasks also counts run_in_background shells, so "subagents"
would misname them (the tooltip gives the full scope). Reuses the shared `pulse` keyframe.

<!-- entry 31 -->
