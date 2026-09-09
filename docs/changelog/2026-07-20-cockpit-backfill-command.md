# New /cockpit:backfill imports existing transcript usage

New `/cockpit:backfill` command imports token usage from EXISTING on-disk transcripts — every past
session for the current repo (default) or all repos (`{all:true}`) — via an authenticated
`POST /internal/backfill`. The daemon resolves each transcript's repo from its recorded `cwd`
(now surfaced by `transcript.readUsage().cwd`), buckets tokens by the real day, dedupes by message id
(seeded from the usage logs), and SKIPS sessions it tracks live — so it is idempotent, re-runnable, and
never double-counts. Backfilled turns contribute tokens/cost only (no prompt count / active time — a
transcript can't reconstruct turn boundaries); coverage is bounded by `retentionDays`.

<!-- entry 8 -->
