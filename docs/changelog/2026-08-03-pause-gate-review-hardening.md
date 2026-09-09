# Pause gate hardened after review, button moved to topbar

Pause-gate review hardening (v0.21.0, pre-commit fixes to #63). Now true, and not to re-break:
`paused` is a DISPLAY-only overlay (`displayStatus`), deliberately kept OUT of `effectiveStatus` — so a
global pause no longer masks a session's error/waiting badge, misfires the resume sound cues, or trips
the long-running chime (all keyed off `effectiveStatus`; error/waiting also outrank the overlay).
`paused.active` is gated on `pauseGateEnabled` so the UI never shows a freeze the gate isn't enforcing.
Manual (`paused`) vs auto (`paused-usage`) sentinels stay distinct: a window reset auto-resumes only its
own auto-pause, never a hand-set one. The pause span accumulator is snapshot-persisted, so an open pause
survives a restart / midnight without resetting its duration (a today-only log fold couldn't). `reconcile`
folds the tracker directly via the shared pure `pause.foldPauseEvent` (also used by `foldPauseState`),
not via a tail re-read a transient throw could strand. Slash commands + statusline route through the
canonical `pause.gateDecision`; the daemon-nudge moved to a cross-platform `scripts/pause-cli.js` (node
http, no `curl` — Windows-safe).
Post-feedback UI tweaks: the Pause/Resume button moved from the Live ribbon to the persistent TOPBAR
(it's a global, all-session control — reachable from any view), and is HIDDEN until the feature is
enabled (no dead control on every page). The PAUSED banner shows the CURRENT pause's elapsed time
(`now − since`), NOT the cumulative `pausedMs` of all prior spans — folding that in made a fresh
1-minute pause read as many minutes. `pausedMs` is still tracked on `/api/state` but no longer surfaced.

<!-- entry 64 -->
