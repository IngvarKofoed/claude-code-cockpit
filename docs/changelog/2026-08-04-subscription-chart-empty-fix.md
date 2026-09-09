# Per-subscription History chart fixed and chip tooltip wired

Fixed the entry-66 History "Tokens & cost per subscription" chart, which always rendered
empty: it summed a per-day `d.bySubscription` field that `buildHistory` never emits — the
breakdown is TOP-LEVEL and range-aggregated (`App.histData.bySubscription`), not per-day.
The Live active-subscription chip's tooltip now actually shows the all-time
`subscriptionTotals` figure (tokens + cost) it was already fetching but not displaying —
was a generic static string, wasting the server-side aggregation entry 66 shipped.

<!-- entry 67 -->
