# Pace delta drops its ahead/behind word

The pace delta dropped its trailing "ahead"/"behind" word — the ▲/▼ arrow + amber/green colour already
convey direction (user's call, "the colour says it all"). It now reads "▲ 6% · 18m", and a muted "·"
joins it to the burn-rate multiplier so the two read as one line: "▲ 6% · 18m · 1.3×". The word survives
only in the hover title ("6% ahead of an even burn rate") to disambiguate the colour. The joining "·" is
a `.usage-bar__mult::before` (muted, like the reset line's separators), so it vanishes with the
multiplier under `:empty` (jumpy-early guard) — no dangling dot.

<!-- entry 55 -->
