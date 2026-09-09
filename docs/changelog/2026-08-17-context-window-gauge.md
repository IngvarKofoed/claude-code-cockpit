# Live cards show a context-window gauge

Live cards now show a CONTEXT-WINDOW gauge (v0.40.0): a thin meter + `ctx N%` under the card
head, so you can see which session is near compaction without reading its statusline.
The statusline forwarder already computed the percentage but sent only `rate_limits`; it now
also forwards `context_window` as a THREE-FIELD projection (percentage + the two token
counts), keeping the forwarded set an allowlist rather than the whole object.
Applied per SESSION, before every rate-limit guard: a stale-subscription push carries wrong
account-wide numbers but its own session's true fill, and an API-key session has no
`rate_limits` at all yet still has a context window. Either half alone is now a valid push.

<!-- entry 118 -->
