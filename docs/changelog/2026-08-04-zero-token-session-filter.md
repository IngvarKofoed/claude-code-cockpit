# Zero-token sessions filtered from lists and counts

Sessions that spent 0 tokens (and so 0 cost) — opened but never worked — are filtered from
the Sessions list, the Live cards, and every session COUNT (Repos/History/Live ribbon)
(v0.22.0). An unreadable transcript is UNKNOWN not zero, so it is KEPT and shown as "—".
CRUCIAL: pollTokens sets a RUNNING first-turn session's tokens to a known {0,0,0,0} before
its first assistant usage flushes, so a bare "known-zero" test would hide actively-running
sessions. Hence an ACTIVE session is NEVER filtered — Live keeps any non-idle card
(`effectiveStatus`), the Sessions view keeps any currently-live session — only a non-live,
idle, token-less session drops. Do NOT "simplify" the idle/live guards away.
Counts = `sessions` (event-observed) ∩ `tokenSessions` (usage-log, spent tokens) via
`aggregate.countedSessions`; a backfill-only session (tokens, no events) still adds no count,
unchanged. `session_id` is now threaded into the usage accumulators for this. Consequence
(deliberate, not fixed): a running first-turn session isn't in the token-based count until
its first Stop — it lags the visible card by one turn, matching Chats/Tokens which already
read 0 for it; counting it would re-admit a 0-token session. Sessions view:
`sessionsFilteredList` classifies each transcript's emptiness once per file-version (cached
by mtime/size) and reuses that parse for the visible page, so the O(total) sweep is amortized
and off the SSE path; `total`/pagination reflect only kept rows. Repos are NOT filtered — a
repo whose only sessions were empty still shows a 0/0 row; the ask was about sessions.

<!-- entry 65 -->
