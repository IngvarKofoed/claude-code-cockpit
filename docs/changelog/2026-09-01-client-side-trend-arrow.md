# Usage trend arrow computed client-side every second

Derived CLIENT-side, re-computed every second, and the arrow ships as sample slices rather than
a server-computed verdict: both the sample window and the affordable-rate denominator move
between statusline pushes, so a frozen verdict would stick exactly when a session goes idle and
the arrow should be decaying to ▼. Accepted cost: `web/` has no test framework and cannot
require the CommonJS `usage.js`, so the ~20 lines of threshold logic are untestable.

<!-- entry 179 -->
