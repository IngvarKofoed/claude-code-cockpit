# cacheWrite1h is optional and falls back to cacheWrite

`cacheWrite1h` is OPTIONAL in a rate and falls back to `cacheWrite` (`pricing.RATE_FALLBACK`).
This is load-bearing, not politeness: adding it to the REQUIRED classes would fail
`isCompleteRate` for every rates map saved before it existed and render the whole dashboard
unpriced. Absent means "price 1h at the 5m rate" — the old behavior — never $0, which would
make 1-hour cache writes free. `validateRate` omits the key rather than defaulting it to 0.

<!-- entry 137 -->
