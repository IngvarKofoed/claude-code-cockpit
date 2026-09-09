# Pause gate detects all-sessions-at-rest and notifies

Pause gate 'safe to close' (v0.26.0): the gate now emits a 'Gated' marker when freezing a tool call;
the daemon derives per-session `atRest` + gatedSince and fires a single 'safe to close' OS
notification (events.safeToClose, default
on) when every session is at rest. The dashboard badge shows 'Paused — parked' with a frozen timer
when at rest, not the instant-'Paused' overlay; the PAUSED banner shows 'N of M at rest' and turns
'All at rest — safe' (green). Release via global 'Resumed' clear (replay-safe) nulls gatedSince
during log replay, so parked-then-resumed sessions boot correctly.
`atRest` = parked OR idle OR error, but a session `waiting` on a permission prompt is NEVER at rest
(it needs the user — closing the laptop would abandon that prompt), so it holds the signal. The
"N of M" count excludes opened-but-never-worked idle sessions, matching the Live grid (entry 65).
Boot into a standing pause stays ARMED unless already at rest, so a mid-pause daemon restart doesn't
drop the ping; reaping the last working session re-evaluates the edge.
Known blind spots (documented, not to re-fix): a run_in_background Bash / concurrent background
subagent can read safe EARLY (parked short-circuits bgTasks); and a session the daemon still believes
is `running` (a dropped Stop with a live owner) holds the ping OFF until the reaper finalizes it.

<!-- entry 75 -->
