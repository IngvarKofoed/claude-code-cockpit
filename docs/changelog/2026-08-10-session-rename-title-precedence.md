# Session names honor the user's /rename over ai-title

Session names now honour the user's `/rename` (v0.34.1): `readUsage` reads the transcript's
`custom-title` alongside `ai-title` and prefers it, tracking both separately so precedence
doesn't hinge on line order. Only `ai-title` was read before, so a renamed session showed the
stale generated name — or, since `ai-title` is now rarely emitted, no name at all on every Live card.
Blank text counts as absent, so clearing one name falls back to the other rather than blanking the card.

<!-- entry 89 -->
