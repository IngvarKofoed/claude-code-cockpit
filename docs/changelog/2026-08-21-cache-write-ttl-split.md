# Cache writes are now tracked and priced by TTL

Cache writes are now tracked and priced by TTL: `cacheWrite` (5-minute, 1.25x input) and a
new `cacheWrite1h` (1-hour, 2x input) fifth token class, split at the source from the
transcript's `cache_creation.ephemeral_{5m,1h}_input_tokens`. Claude Code writes ~41% of
its cache at 1h, so one blended rate understated cost badly — measured $2,153 on Opus 4.8
alone. `cache_creation_input_tokens` stays authoritative for the sum (5m is its remainder).

<!-- entry 136 -->
