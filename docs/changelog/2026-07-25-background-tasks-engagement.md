# Session engagement now derives from background_tasks count

Session engagement (active-time clock + the card's big "working" timer) now derives from Claude Code's
authoritative `background_tasks` count — `emit.js` stores its LENGTH as `bgTasks` (Stop/SubagentStop payload,
v2.1.145+) — replacing the ±unreliable subagent start/stop counter, whose skew (up to +12 in a real day's
log) stranded done sessions "engaged": a phantom timer under an Idle badge + the idle gap folded into active.
`isEngaged = running || bgTasks>0`; a shared client `effectiveStatus` (and the server card sort) read a
session with background work in flight as "running", so badge/colour/timer/sort all agree. Bonus: a
`run_in_background` Bash (registry type "shell") now counts as active (closes an entry-14 gap); graceful on
Claude Code <2.1.145 (no `background_tasks` → running-only, no phantom). Stores the COUNT only — a task's
command/name/description is free text (paths, prompts) and would breach the no-message-content boundary.

<!-- entry 25 -->
