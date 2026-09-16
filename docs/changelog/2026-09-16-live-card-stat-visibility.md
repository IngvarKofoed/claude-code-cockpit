# Live card stats can be hidden, by column or altogether

Each Live card's six stat columns (Tokens · Cost · Chats · Tools · Agents · Active) can now be
switched off per browser, in Settings ▸ Dashboard, and a single **Show stats** switch hides the
whole block — **both rows together**, the per-session figures and the muted repo-wide totals
beneath them. Hiding a column takes its heading *and both rows' cells* with it, so the grid
reflows rather than leaving a gap. This is a density control, not cosmetics: the card's stat row
is what sets the grid's column width, so hiding stats is what lets more cards — or more
groups — fit across.

## Detail

- **Measured, not guessed.** With every column on, a data-heavy card's cells start clipping at
  **440px**; at three visible columns nothing clips even at 420px. The `.cards` comment claiming
  420px as the floor was written for a 7-column row and is now optimistic — the existing grid only
  gets away with it because `1fr` stretches cards to ~444px at three columns. Hiding the stats
  block entirely takes a card from 322px to 249px tall.
- **One switch covers both rows, not two switches.** The two rows are read as a single unit — the
  muted totals sit under their matching per-session heading and mean nothing detached from it — so
  a state with one row and not the other was dropped as soon as it was built. The per-column
  checkboxes are the finer lever, and they apply to both rows at once.
- **Both rows now come from ONE column list** (`cols` in `cardHTML`). They were two parallel push
  sequences kept in the same order by hand; with columns user-hideable, any drift would have filed
  a repo total under the wrong heading. They can no longer diverge.
- **Known boundary, deliberately not tuned away:** inside a *vertical group* at default settings the
  card is 420px, and the widest repo-total cost (a 4-figure `$3929.08`) ellipsizes by a few pixels.
  Shaving padding or the column gap would buy ~3px and break again at five figures, so the fix is
  the setting itself — hide a column or two. Ungrouped cards are unaffected (`1fr` gives them
  ~444px).
- **Settings row is stacked, not side-by-side.** Six checkboxes beside the description squeezed it
  into a five-line ribbon, so `fieldRow` gained a `wide` flag that drops the control onto its own
  full-width line. Only this row uses it.
- Guard shape matches the rest of `cockpit.liveShow`: any key omitted or non-false stays **shown**,
  so a value stored before this existed still defaults every column and both rows on. Verified that
  toggling fires no config PUT and no "Settings saved" toast — it is a per-browser pref, not config.
