# Per-day bySubscription emitted for any subscription count

`/api/history` now emits per-day `bySubscription` for ANY number of subscriptions whenever
cost display is on (v0.39.0) — it was gated at 2+, mirroring the client gate entry 116 removed.
Found by making the card always visible: a single-subscription range (e.g. Today) had no
per-day data at all, so the chart fell to its all-zero empty state while the range aggregate
plainly had cost. Cost is one memoized merge+price per day in range, so the gate bought little.

<!-- entry 117 -->
