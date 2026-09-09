# Changelog number collisions resolved by keeping origin's numbers

Changelog numbers 121–132 were double-booked once, by two branches that each numbered from
121 off a shared base (pricing locally, Windows focus via PR #4). Resolved at the merge by
renumbering the UNPUSHED side up (+12 → 133–145) and leaving the pushed numbers alone.
That is the rule for any future collision: whichever side is already on origin keeps its
numbers, since other entries and PR history already reference them.

<!-- entry 146 -->
