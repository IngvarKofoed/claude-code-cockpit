# Config and daemon lifecycle hardened for safety

Config/lifecycle hardening. Now true:
port is bounded 1–65535 (an out-of-range port was persisted and crash-looped the daemon on listen);
`retentionDays <= 0` means keep-forever (never prune), and a cleared numeric Settings field reads as its default not 0 — together they prevent silently wiping all history;
the cost `rates` map is authoritative (replaces, not merges), so the Settings remove-button actually deletes a default model's rate;
`ensure.js` replaces an old-version daemon (SIGTERM the old + the new daemon's lock acquisition retries until it releases);
`owner_pid` is captured on every event (not only `SessionStart`) so the reaper works after a snapshot loss, and it now waits a 90s quiet grace before reaping a PID-dead session (guards a transient-shell `ppid`);
`PostToolUse`/`PostToolUseFailure` restore `running`, so a session isn't stuck `waiting` after a permission is approved.

<!-- entry 5 -->
