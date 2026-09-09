# Known limitations and deferred follow-ups documented

Known limitations / deferred follow-ups (not bugs, but do not "re-fix" as if new):
`activityDetail: "args"` is accepted and shown in Settings but not yet wired — `emit.js` never stores tool arguments (privacy), so the control has no effect yet;
`transcript.readUsage` re-reads the whole transcript each call — the architecture's incremental per-session-offset tail is deferred (correctness is fine; a cost only for very large transcripts);
the reaper keys off `process.ppid`, whose meaning (Claude Code process vs. a launching shell) needs per-OS verification — the 90s grace mitigates a transient-shell false-reap;
a stale session is dropped, not marked `ended (stale)` — acceptable while there is no session-history store to move it to.

<!-- entry 6 -->
