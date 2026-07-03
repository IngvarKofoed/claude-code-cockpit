# Changelog

Each entry is numbered with a monotonically increasing integer. Append new entries to the end. Never reuse or reorder numbers. Numbers are globally unique across this file and any future `CHANGELOG-archive.md` — never reused. Write each entry as durable project memory: what is now true that wasn't before, plus the why in a clause when not obvious — not a recap of the diff (filenames and mechanical edits live there). Keep it to 1–5 lines, ~20 words per line at most; never one packed run-on line.

1. Metrics store is timestamped JSONL, not a database: a hook-written event log plus a daemon-written per-turn token-usage log, over materialized daily rollups.
   Token deltas are persisted (not just counted in memory) so history graphs can chart tokens over time and survive daemon restarts.
   SQLite was rejected for now to keep the zero-native-dependency property; it stays a migration path behind the store interface.

2. Design hardened after an external review (Codex GPT-5.3 + Gemini 3.1 Pro), before any code exists.
   Daemon singleton is an exclusive OS lock, not a health-check (avoids TOCTOU double-spawn); logs are canonical with byte-offset idempotency and the open day's rollup rebuilt on boot (crash-safe).
   All HTTP/SSE/internal endpoints require a 0600 bearer token + Origin check — localhost bind alone isn't access control on shared machines.
   Transcript reads retry for async flush and key usage by message id; stale-reaper keys off the owning PID; SSE resyncs via /api/state on reconnect.
   Activity-argument detail (file path / command) is now default-off (`activityDetail`) to preserve the "no message content" guarantee; tool names are always shown.

3. Full v0.1–v0.3 implementation landed: hook `emit.js`, `ensure`/`ensure-deps`, the always-on `daemon.js`,
   the pure core (`aggregate`/`transcript`/`repo`/`pricing`), `config`/`paths`/`notify`, the buildless web SPA
   (Live/Per-repo/History/Settings over SSE), the `/cockpit:*` commands, and plugin wiring.
   Plugin is named `cockpit` (so commands resolve to `/cockpit:*`); `paths.APP_NAME` stays `claude-code-cockpit`.
   82 unit tests pass; daemon verified end-to-end (auth enforced, token ingestion, pricing, restart idempotency).
   Confirmed via docs: `StopFailure`/`SubagentStart`/`PostToolUseFailure` are real hooks; `effort.level` is nested;
   `Notification` carries `notification_type`; commands namespace off the plugin name.

4. Accounting made crash-safe after two adversarial review passes. Now true:
   day-rollover drains the outgoing day's log before freezing it (a turn logged just before midnight is no longer lost);
   `StopFailure` ingests the failed turn's tokens (not just `Stop`), so a rate-limited turn's cost isn't dropped;
   multi-model turns are priced per model (`accumulateTurnByModel` + a `byModel` usage record), fixing under-counting when a turn spans models;
   `seenIds` is persisted in the snapshot so a restart never re-counts already-billed messages even after usage logs are pruned.

5. Config/lifecycle hardening. Now true:
   port is bounded 1–65535 (an out-of-range port was persisted and crash-looped the daemon on listen);
   `retentionDays <= 0` means keep-forever (never prune), and a cleared numeric Settings field reads as its default not 0 — together they prevent silently wiping all history;
   the cost `rates` map is authoritative (replaces, not merges), so the Settings remove-button actually deletes a default model's rate;
   `ensure.js` replaces an old-version daemon (SIGTERM the old + the new daemon's lock acquisition retries until it releases);
   `owner_pid` is captured on every event (not only `SessionStart`) so the reaper works after a snapshot loss, and it now waits a 90s quiet grace before reaping a PID-dead session (guards a transient-shell `ppid`);
   `PostToolUse`/`PostToolUseFailure` restore `running`, so a session isn't stuck `waiting` after a permission is approved.

6. Known limitations / deferred follow-ups (not bugs, but do not "re-fix" as if new):
   `activityDetail: "args"` is accepted and shown in Settings but not yet wired — `emit.js` never stores tool arguments (privacy), so the control has no effect yet;
   `transcript.readUsage` re-reads the whole transcript each call — the architecture's incremental per-session-offset tail is deferred (correctness is fine; a cost only for very large transcripts);
   the reaper keys off `process.ppid`, whose meaning (Claude Code process vs. a launching shell) needs per-OS verification — the 90s grace mitigates a transient-shell false-reap;
   a stale session is dropped, not marked `ended (stale)` — acceptable while there is no session-history store to move it to.
