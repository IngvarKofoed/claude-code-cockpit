# Storage size and manual cleanup added to settings

Manual data management added. `GET /api/storage` reports the store's on-disk size (events+usage+rollups
+snapshot, excluding daemon.log) and day span, computed per-request and never on the SSE hot path.
`POST /api/data/cleanup {olderThanDays:N}` deletes whole day-files older than today−N (never today's) — the
safe subset of the old auto-prune: whole-file unlinks, no concurrent writers. Surfaced in a new Settings
"Data" section: store size + an N-days cleanup whose confirm previews the scope before committing.

<!-- entry 28 -->
