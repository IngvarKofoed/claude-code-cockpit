# Live cards show the session's /color as a dot

Live cards show the session's `/color` as a dot before the name's tag glyph, so a card can be
matched to the terminal window it belongs to. Fed by the transcript's `agent-color` lines (last
wins; `default` or an unmapped name clears it) — no new state, hook or event, since
`transcript.js` already scanned every line for `custom-title`. Assigned UNCONDITIONALLY unlike
`title`, so a reset can clear it; every caller already gated on `usage.ok`, so null isn't a
partial read. Kept off the rail and badge: both are wholly spent on status, where a coloured
dot would read as a status light.

<!-- entry 149 -->
