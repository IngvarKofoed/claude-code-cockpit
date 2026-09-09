# Opus 5 now prices out of the box

Opus 5 now prices out of the box (v0.41.0) at the Opus 4.5+ tier ($5/$25, cacheRead 0.5 / cacheWrite 6.25).
It was unpriced, so every Opus 5 turn rendered "—" and its cost was silently dropped from
totals (`estimateCost().total` sums only priced models) — $989 of real spend in this store.
Known limit: fast mode bills $10/$50 but carries the same model id, so it under-estimates.

<!-- entry 133 -->
