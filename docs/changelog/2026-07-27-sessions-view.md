# New Sessions view lists every retained transcript session

New top-level Sessions view (v0.10.0) + `GET /api/sessions` listing EVERY retained Claude Code session by
reading the transcript filesystem directly (`~/.claude/projects/<encoded-cwd>/*.jsonl`), not the cockpit's
store — newest-first by file mtime, paginated (`pageSize` default 50, clamped `[1,100]`; `page` coerced,
out-of-range → empty page + correct total). Every transcript is exactly one row (no file dropped), so
`total` equals the rendered count and paging is exact. Names come from the transcript `ai-title`; the
verbatim `last-prompt` is NEVER surfaced — that line is the privacy boundary (derived label yes, raw text
no). Cost bounded by a ~3s stat/sort snapshot (sweep) + a per-file mtime/size parse cache (parse), so the
O(total) scan never runs on the SSE hot path.
Deliberate consequence: this view follows CLAUDE CODE's transcript retention, not the cockpit's — so a repo
removed via `/api/repos/delete` (or days via `/api/data/cleanup`) still lists its sessions here. The price
of complete coverage with no new store/writer; "active" is a client overlay intersecting the live stream.
The endpoint reads each page's transcripts ASYNCHRONOUSLY (never a blocking readFileSync on the event loop),
so a cold page can't stall SSE/hooks/notifications for other sessions. An unreadable/unparseable transcript
shows tokens as UNAVAILABLE ("—"), never a misleading 0/$0.000 (the graceful-degradation rule).

<!-- entry 35 -->
