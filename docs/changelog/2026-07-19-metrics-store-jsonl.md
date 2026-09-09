# Metrics store is timestamped JSONL, not a database

Metrics store is timestamped JSONL, not a database: a hook-written event log plus a daemon-written per-turn token-usage log, over materialized daily rollups.
Token deltas are persisted (not just counted in memory) so history graphs can chart tokens over time and survive daemon restarts.
SQLite was rejected for now to keep the zero-native-dependency property; it stays a migration path behind the store interface.

<!-- entry 1 -->
