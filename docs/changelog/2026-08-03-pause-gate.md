# Pause gate freezes tool execution via a control file

Pause gate landed (v0.21.0): a separate blocking `PreToolUse` hook (`gate.js`) reads a control file
(`stateDir/cockpit.pause`) and freezes every session's tool execution when it holds a paused sentinel;
opt-in (`pauseGateEnabled` config), fail-open (missing/garbage file runs tools), fail-safe-deny at ~24h.
Pause/Resumed events recorded in the log; daemon folds them into global `pausedMs` + live `paused` status
(derived, not per-session). Optional auto-pause when 5h usage crosses a threshold, auto-resume on window
reset, both reusing entry-42 rate-limit data. Control file is sole ruler — no chat-prompt resumption.
Dashboard Pause/Resume button + `/cockpit:pause|resume` commands + `POST /api/pause` + PAUSED banner +
statusline segment. Limitation: paused mid-tool wait counts as active time (clock adjustment deferred).

<!-- entry 63 -->
