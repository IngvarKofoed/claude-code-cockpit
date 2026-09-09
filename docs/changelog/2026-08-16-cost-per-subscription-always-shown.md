# Cost per subscription chart is always shown

The History "Cost per subscription" card is now ALWAYS shown (v0.39.0), reversing entry 72's
hide-below-2-subscriptions — a single subscription's line restating the chart above it is
accepted as the price of a stable view. Since it can no longer hide, its empty state
distinguishes the two empties: no activity at all vs. real activity on unpriced models
("no rate configured"), because lineChart treats an all-zero-cost series as empty and
"no history yet" would be wrong for it.

<!-- entry 116 -->
