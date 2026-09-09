# Session name line always renders even when empty

The session-name line is now ALWAYS rendered on a Live card (v0.32.0) — the tag icon shows even when
there's no name yet (empty text), reversing entry 80's "omit when no title". A fixed line-height +
min-height (16px) holds the row so the icon-only line matches a named line's height rather than
collapsing, keeping the card layout stable whether or not a title has arrived.

<!-- entry 82 -->
