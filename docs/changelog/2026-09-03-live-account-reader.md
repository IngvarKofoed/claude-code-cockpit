# Daemon reads the live account itself via account.js

The daemon now reads the LIVE account itself. `emit.js`'s reader moved to a shared
`scripts/account.js`; the daemon wraps it in an mtime cache refreshed on a usage push and a
Stop-time ingest, NEVER from `buildStatePayload` (no filesystem work on the SSE hot path).
`aggregate.currentSubscription` survives only as the fallback for an unreadable file.

<!-- entry 185 -->
