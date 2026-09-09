# Pricing resolves context-variant model ids to base rates

Rates resolve through a base-model fallback, so a context-window variant id
(`claude-opus-5[1m]`) prices at its base rate instead of reading as unpriced. Safe because
Opus 4.7+/Sonnet 5 ship 1M context with no long-context premium; an explicit variant entry
still wins, leaving room for a future premium variant. Also fixes `claude-opus-4-8[1m]`.
`daemon.costByTypeFor` had to resolve the same way or its cost-by-type split would count a
variant as priced yet add $0, breaking its Σ-classes === day-total invariant.

<!-- entry 134 -->
