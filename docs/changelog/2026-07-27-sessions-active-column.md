# Sessions view gains an event-derived Active column

Sessions view gains an **Active** (engaged time) column, and **Last active** moved to the far right.
Active time can't come from transcripts (it's event-log-derived), so a new `aggregate.accumulateSessionActiveFromEvents`
replays the event log PER SESSION with the SAME engaged clock as Live/Per-repo — so a repo's active time equals the
sum of its sessions' by construction. A live session uses its live `activeMs`; a past session the cockpit observed
uses a cached event-log index (per-past-day memoized, summed under the snapshot TTL, invalidated on rollover/cleanup/
repo-delete); a session the cockpit never saw (pre-install / transcript-only, no events) shows "—", not a false "0s".
The index build is ASYNC (reads each day's log with an await between days), so even a cold build after boot/cache-clear
never freezes the event loop replaying all history at once. A session the cockpit DID observe but that did no engaged
work is recorded as 0 (shows "0s"), kept distinct from a never-observed session ("—"). A live row's Active uses the
fresh live `activeMs` and is updated in place each SSE frame (no table rebuild, so text selection survives).

<!-- entry 36 -->
