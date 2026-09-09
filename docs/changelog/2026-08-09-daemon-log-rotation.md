# daemon.log now self-bounds via rotation

daemon.log now self-bounds (v0.33.0) — rotated to `daemon.log.1` once it passes ~5MB (checked at boot, then hourly),
keeping ~2 generations so it can't grow unbounded. Still excluded from the `/api/storage` size report and
the manual cleanup (a single file, not a day-partitioned data log). Safe because `log()` append-writes by
path (no held stream) and the daemon is the sole writer of this file, so the rename can't race a writer.

<!-- entry 87 -->
