# Idle title backfill no longer skips already-named sessions

The idle-session title backfill no longer skips already-named sessions (v0.34.1) — it dropped out on
`s.title != null`, which is exactly the case a `/rename` hits, so a rename while idle never reached the
Live card. The transcript-mtime gate alone now bounds the cost: one re-read per actual transcript write.

<!-- entry 90 -->
