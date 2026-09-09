# Unknown-subscription turns excluded from the breakdown

Turns with NO known subscription are now EXCLUDED from the per-subscription breakdown (v0.24.0):
the `'unknown'` bucket is gone, dropped at the `aggregate.addBySubscription` source (`subId==null`
→ skip), so it vanishes from `subscriptionTotals`, the History chart, and per-repo `bySubscription`
at once (past days recompute, no migration). Scoped to the subscription DIMENSION only — those
tokens/cost still count in repo totals via `addByModel`, so a split can sum to LESS than the total.

<!-- entry 70 -->
