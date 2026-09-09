# Cost-per-subscription card hidden below two subscriptions

The "Cost per subscription" card is HIDDEN unless the range has 2+ subscriptions with token activity
(v0.24.0) — with one, its line just restates "Tokens & cost per day", so the whole card is removed
(`display:none`), not emptied; re-evaluated each draw. With cost ON it also needs one nonzero cost (an
all-unpriced range → hidden, not an empty chart on a visible card; an unpriced sub among priced ones
still plots a flat $0 line). Cost OFF shows the standard cost-off placeholder.

<!-- entry 72 -->
