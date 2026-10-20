# Vertical group boxes fill the row, one grid track each

A vertical group box now grows to one track of the Live column. Three of them end flush with the
ribbon and usage rows, and every box lands on the ungrouped grid's tracks. Before, each one held its
438px basis and stopped 18px short at the usual 1356px column.

## Detail

- **The cap is the point, not the grow.** A plain `flex-grow` would stretch a lone vertical group,
  or the last one on a wrapped row, across the whole column as a single 1300px-wide stacked card.
  `max-width` holds it to one track, the same width the ungrouped `auto-fill` grid gives a lone card.
- **Track count comes from container queries on `.groups`** (888px gives 2 tracks, 1338px gives 3),
  because CSS has no floor() over a length ratio to count how many 438px boxes fit. The queries stop
  at three because `.main`'s 1400px max-width holds the column to 1356px. If that max-width ever
  grows, add a 4-track query at 1788px.
- **Rejected: a CSS grid for `.groups`** with vertical groups spanning 1 track and horizontal ones 2.
  A grid can't grow an item into the rest of its row, so two horizontal groups would each sit at
  2/3 width with a hole beside them. A 3-member band would also drop from 3 cards across to 2.
  `grid-auto-flow: dense` would fill the holes but reorder boxes, breaking the user-set order
  (`2026-09-22-group-box-reordering`). Horizontal groups keep their uncapped `flex: 1 1 870px`.
- **Narrow windows changed too.** Below 888px a vertical group now fills the column, like the
  ungrouped cards, where it used to sit at 438px with slack beside it.
- **Two column widths where edges don't line up, accepted:** 852–888px and 1284–1338px. In both
  the ungrouped grid already fits one more 420px track than the groups fit 438px boxes. A group
  track can't drop below 438px without taking a grouped card under the 420px card floor
  (`2026-09-16-live-card-groups`).
- **Verified** in a real browser against the live daemon at 1600, 1200 and 800px windows, with one
  vertical group, four (the fourth wraps), vertical+horizontal in both orders, two horizontal, and
  three vertical. All edges landed on the ungrouped grid's tracks, with no console errors.
