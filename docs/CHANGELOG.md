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

7. Token usage is bucketed by the day each turn actually happened, not by ingest time.
   `transcript.js` surfaces each message's `timestamp`; on ingest the daemon groups a session's new messages
   by day — the latest-timestamp group is the completed turn (prompt + duration, correct even across a
   midnight boundary), earlier days are historical backfill (tokens/cost only, `accumulateTokensByModel`).
   Past days' rollups are DERIVED ON DEMAND from their usage logs (single source of truth), never persisted
   or amended in place, and each session's counted-id set is re-seeded from those logs before ingest — so
   backfill is idempotent and crash-safe (a restart, resume, or corrupt rollup file can't double-count or lose
   tokens). History/date-range views thus show real dates on a first ingest of a long-running/resumed session's
   prior work, instead of dumping it all into "today". Known limit: byHour for backfilled days is coarse (1 bucket/day).

8. New `/cockpit:backfill` command imports token usage from EXISTING on-disk transcripts — every past
   session for the current repo (default) or all repos (`{all:true}`) — via an authenticated
   `POST /internal/backfill`. The daemon resolves each transcript's repo from its recorded `cwd`
   (now surfaced by `transcript.readUsage().cwd`), buckets tokens by the real day, dedupes by message id
   (seeded from the usage logs), and SKIPS sessions it tracks live — so it is idempotent, re-runnable, and
   never double-counts. Backfilled turns contribute tokens/cost only (no prompt count / active time — a
   transcript can't reconstruct turn boundaries); coverage is bounded by `retentionDays`.
