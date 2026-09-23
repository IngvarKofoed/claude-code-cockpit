# Group picker stays on-screen; groups deletable from the picker

A card's group picker (and the repo table's menu) now opens **above** its button when there is
no room below, capped to the viewport and scrolling inside, instead of opening off-screen for a
card near the page bottom. A grouped card's picker offers **Delete group…**, and the group
header's delete button is now a bin instead of an ×.

## Detail

- **Why delete looked missing.** The header already had a delete button
  (`2026-09-16-live-card-groups`), but as a muted × on a bounded box it read as "close panel" and
  went unnoticed. The bin glyph fixes the reading; the picker item gives it a second, labelled home.
- **Scrolling to reach an off-screen menu was never a workaround:** `closeMenu` fires on any
  scroll, so the old below-only placement made the menu unreachable, not merely inconvenient.
- **A scroll inside a capped menu must not close it.** The close-on-scroll listener is capture
  phase, so it sees the menu's own scroll; `onScrollForMenu` ignores scrolls whose target is inside
  the menu. `.menu > *` is `flex-shrink: 0` so a capped menu scrolls instead of squashing its
  separators to 0px.
- **Empty groups stay undrawn, by choice — not a gap to close.** The user confirmed hiding a
  group with no live cards is wanted behaviour, so it has no header and no delete there; add a card
  to it to get its controls back (`2026-09-16-live-card-groups`). A per-row delete in the picker's
  group list was considered and left out to keep the list a pure chooser.
- **Verified** in a real browser against the live daemon: a card 40px above the viewport bottom
  opened its picker above the button, fully visible; the grouped card's picker listed
  "Delete group “…”…" as a danger item that opened the existing confirm; no console errors.
