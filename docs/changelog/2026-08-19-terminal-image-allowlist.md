# Title match gated on a terminal-image allowlist

That match is gated on a terminal-image ALLOWLIST, never window class (v0.41.0) — Tabby's class
is `Chrome_WidgetWin_1`, identical to Chrome's, so class cannot vouch for a terminal and a
browser tab named after the session would have been raised as one. Non-terminals are filtered
BEFORE the ambiguity count, so a browser can neither win nor block a real match. An unlisted
terminal gets no button — add to the list rather than loosening the rule.

<!-- entry 128 -->
