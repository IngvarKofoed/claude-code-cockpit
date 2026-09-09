# Token usage bucketed by day it happened

Token usage is bucketed by the day each turn actually happened, not by ingest time.
`transcript.js` surfaces each message's `timestamp`; on ingest the daemon groups a session's new messages
by day — the latest-timestamp group is the completed turn (prompt + duration, correct even across a
midnight boundary), earlier days are historical backfill (tokens/cost only, `accumulateTokensByModel`).
Past days' rollups are DERIVED ON DEMAND from their usage logs (single source of truth), never persisted
or amended in place, and each session's counted-id set is re-seeded from those logs before ingest — so
backfill is idempotent and crash-safe (a restart, resume, or corrupt rollup file can't double-count or lose
tokens). History/date-range views thus show real dates on a first ingest of a long-running/resumed session's
prior work, instead of dumping it all into "today". Known limit: byHour for backfilled days is coarse (1 bucket/day).

<!-- entry 7 -->
