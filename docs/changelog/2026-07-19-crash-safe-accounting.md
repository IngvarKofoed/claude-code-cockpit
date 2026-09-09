# Accounting made crash-safe after adversarial review

Accounting made crash-safe after two adversarial review passes. Now true:
day-rollover drains the outgoing day's log before freezing it (a turn logged just before midnight is no longer lost);
`StopFailure` ingests the failed turn's tokens (not just `Stop`), so a rate-limited turn's cost isn't dropped;
multi-model turns are priced per model (`accumulateTurnByModel` + a `byModel` usage record), fixing under-counting when a turn spans models;
`seenIds` is persisted in the snapshot so a restart never re-counts already-billed messages even after usage logs are pruned.

<!-- entry 4 -->
