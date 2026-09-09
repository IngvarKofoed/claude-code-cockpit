# New usage-samples buffer backs the sliding burn rate

That needs history the daemon never kept (`rateLimitUsage` is one overwritten snapshot), so
it now holds a change-only `usageSamples` buffer of `{t, pct, sub}`, snapshot-persisted and
pruned to 24h — except the newest entry PER SUBSCRIPTION beyond that horizon, which is kept
as the anchor. Dropping it would strand exactly the case it serves: a flat stretch longer
than the horizon would lose the only evidence the value is flat.

<!-- entry 162 -->
