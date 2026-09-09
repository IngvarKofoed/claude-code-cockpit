# Live session cards can be pinned to lead the grid

A session card can now be **pinned**, and pinned cards lead the Live grid while the selected
sort still orders within the pinned group and within the rest. Pins are per-session (keyed on
`sessionId`), per-browser (`cockpit.livePins`), and toggled from a pushpin button in the card
head behind an `App.liveShow.pin` switch (default on). With nothing pinned the partition is
skipped entirely, so every sort mode orders exactly as it did before.
Spec: `docs/specs/2026-09-09-live-card-pinning.md`.

## Detail

- **A pinned card outranks a `waiting` one** — a deliberate reversal of the waiting-first rule
  `aggregate.statusRank` applies, chosen because a pin is an explicit user act and one rule
  beats a rule with an exception. `docs/CONCEPT.md`'s Vision bullet and `ARCHITECTURE.md`'s
  Live bullet were amended in the same change rather than left contradicting the code. The
  accepted cost: a blocked session can sit below the pinned block with no global cue, because
  the ribbon's Waiting tile was removed (`2026-07-30-live-ribbon-totals-tiles`) — that entry
  named the tile as the backstop for a mode where waiting isn't floated, and this reopens it.
- **The 50-pin cap evicts the oldest pin whose session is NOT currently live**, falling back to
  the plain oldest only if all 50 are live. Evicting by pin age alone would have unpinned a
  long-lived session you resume daily — exactly the case the no-pruning rule exists to protect
  — while dead ids survived. This is eviction order, not pruning: nothing is dropped below the
  cap, so a pin re-applies to a session resumed under the same id (`--resume` reuses it).
- **Hiding the pin button does not clear pins.** They stay active and keep leading the grid;
  turn the switch back on to unpin. Stated in the Settings description rather than left as a
  surprise, per the `/color` dot's precedent (`2026-08-25-color-dot-visibility-toggle`).
- **Pinned state is fill, not hue** — the status palette is wholly spent on the rail/badge
  semaphore and the accent blue reads as a meter level (`2026-08-28-accent-blue-meters`), so a
  coloured pin would claim a meaning already assigned.
- Rejected: **repo-scoped pins**, which cannot separate two sessions of one repository — the
  case a pin is most useful for; and **daemon-side pins** broadcast over SSE, which would turn
  a view preference into server state when every comparable Live preference is per-browser.
- **The toggle re-focuses itself after the re-render.** Its own click rebuilds `cards.innerHTML`,
  destroying the clicked node — unlike `.focus-btn`, whose click only fires a POST — so without
  this a keyboard user lands on `<body>` and cannot toggle the same pin twice. Refocused with
  `preventScroll`, since a pinned card jumps to the top and following it would yank the page.
- Known limit: pinning is ordering only. A pinned session still hidden by the idle-and-zero-token
  filter stays hidden, since that filter runs before ordering.
