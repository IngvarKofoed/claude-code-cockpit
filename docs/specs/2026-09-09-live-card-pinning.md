# Pinned session cards on the Live page

Let a session card be **pinned** so it sorts ahead of every unpinned card, while the
selected Live sort continues to order each group internally. Pins are per-session,
per-browser, and toggled from a small button in the card head. The whole feature is
client-side: no daemon change, no new endpoint, no new stored state on disk.

## Outcome

**What you get:**

- Pinned session cards lead the Live grid in every sort mode, with the selected sort
  still ordering within the pinned group and within the rest.
- A pin toggle in each card head that shows the pinned state at rest, so a card at the
  top is distinguishable from one that merely sorted there.
- Pins persist in this browser across reloads, and re-apply if a pinned session is later
  resumed with the same `session_id`.
- No change to card **order** until something is pinned — every sort mode orders exactly
  as it does today. (The pin control itself is always present; see *The control*.)

**How to verify:**

- With three or more live sessions, pin the bottom card: it moves to the top and stays
  there across SSE frames; unpinning returns it to its sorted position.
- Pin two cards, then change the Live sort in Settings > Dashboard: both stay ahead of
  the unpinned cards, and their order relative to each other follows the new sort.
- Reload the dashboard: the same cards are still pinned and still lead the grid.
- With one session `waiting` on a permission prompt and another pinned, the pinned card
  leads — the deliberate divergence, visible.
- With nothing pinned, the card order in all three sort modes is identical to today's.

## Key decisions

- **A pin identifies the session, not the repo** (new). Keyed on `sessionId`, so two cards
  of the same repository can be pinned independently — which is most of the value when a
  repo has several sessions. The cost is that a pin dies with its session; see the bounding
  decision below.
- **Per-browser `localStorage`, never daemon config** (reuses). A new `cockpit.livePins` key
  alongside `cockpit.liveSort` / `liveTitle` / `liveShow` / `theme`. Pinning is a view
  preference about the grid in front of you, exactly like the sort mode it modifies, so it
  follows that precedent rather than becoming server state broadcast over SSE.
- **Ordering is a stable partition applied *after* the existing sort** (extends). Each mode
  computes its order exactly as it does today; the partition then lifts pinned cards to the
  front, preserving relative order within both groups. `Array.prototype.sort` is
  stability-guaranteed, and the partition is a two-bucket pass, so nothing re-orders.
- **Pinned outranks everything, including `waiting`** (diverges). A pinned card leads even
  when another session is blocked on a permission prompt. This deliberately overrides
  `statusRank`'s waiting-first rule (`scripts/aggregate.js:557`), `ARCHITECTURE.md`'s "`waiting`
  sessions sort to the top" and CONCEPT's "surfaced first so nothing stalls unnoticed" — all
  three are amended rather than quietly contradicted (see *Docs to update*). One rule beats a
  rule with an exception; the accepted cost is that a blocked session can sit below the pinned
  block with no global cue, since the ribbon's Waiting tile was removed (`2026-07-30-live-ribbon-totals-tiles`).
- **With no pins, every mode behaves exactly as today** (reuses). The partition is skipped
  entirely when the pin set is empty, so `"status"` keeps rendering the daemon's
  `compareCards` order verbatim rather than becoming a client-sorted mode by default.
- **Bounded by a cap that evicts the oldest *non-live* pin first** (new). The stored list is
  capped at `MAX_PINS = 50`; over the cap, the oldest id whose session is not currently live
  is dropped, falling back to the plain oldest only if all 50 are live — so the cap never
  silently unpins a visible card. Deliberately *not* pruned against the live
  session set: `--resume` reuses `session_id`, so a pin on a session you resume later still
  applies, and pruning would silently discard it.
- **The control is a toggle button in the card head, beside Focus, behind `liveShow.pin`** (extends). Same shape,
  position and hover treatment as `.focus-btn` (`web/styles.css`), in the head's left action
  cluster — `.badge` carries `margin-left: auto`, so it stays pushed right.
- **Pinned state is signalled by glyph fill, not colour** (diverges). An outline pin when
  unpinned, a filled pin at full-strength ink when pinned. No hue: the status palette is
  wholly spent on the status semaphore (rail + badge) and the accent blue now reads as a
  meter level, so a coloured pin would claim a meaning the project has already assigned.
- **Pinning does not override visibility** (reuses). The idle-and-zero-token filter at the
  top of `renderLive()` still runs first, so pinning cannot resurrect a hidden card.

## Goals

- Float the sessions you care about to the top of the Live grid, independent of sort mode.
- Keep the selected sort meaningful — it orders within pinned and within unpinned alike.
- Make the pinned state legible at rest, not inferable only from position.
- Change nothing about the card **order** when the user has pinned nothing.

## Non-goals

- **Shared or cross-device pins.** Per-browser, like every other Live preference.
- **Repo-scoped or cwd-scoped pinning.** Considered and rejected below.
- **Manual ordering among pinned cards.** They follow the selected sort, per the request.
- **Pinning anywhere else.** The Sessions table and Repos table are untouched.
- **A daemon-side pin concept.** `compareCards` and `/api/state` are unchanged.
- **A bulk “clear all pins” control.** Pins are removed from the card that carries them;
  the cap bounds anything stranded by an ended session.

## Design

### State

`App.livePins` — a `Set` of session ids, initialised empty and loaded in `init()`
(`web/app.js`, beside the existing `cockpit.liveSort` / `liveTitle` / `liveShow` reads):

```js
// Per-browser pinned session ids. Malformed/absent → empty, matching the liveShow guard.
try {
  const raw = loadPref("cockpit.livePins");
  const v = raw ? JSON.parse(raw) : null;
  if (Array.isArray(v)) App.livePins = new Set(v.filter((x) => typeof x === "string"));
} catch (_e) { /* keep the empty default */ }
```

Persisted as a JSON array (insertion-ordered, oldest first) so the cap can drop the oldest:

```js
function toggleLivePin(sessionId) {
  if (!sessionId) return;
  if (App.livePins.has(sessionId)) App.livePins.delete(sessionId);
  else {
    App.livePins.add(sessionId);
    evictIfOver();
  }
  persistPref("cockpit.livePins", JSON.stringify([...App.livePins]));
  renderLive();
}
```

Eviction drops the oldest id **whose session is not currently live**, so the cap can never
silently unpin a card you can see, and a long-lived session you resume daily outlives 49 dead
ids. It falls back to the plain oldest only if all `MAX_PINS` are live:

```js
function evictIfOver() {
  if (App.livePins.size <= MAX_PINS) return;
  const live = new Set(((App.state && App.state.sessions) || []).map((s) => s.sessionId));
  for (const id of App.livePins) {           // Set iteration is insertion-ordered: oldest first
    if (App.livePins.size <= MAX_PINS) break;
    if (!live.has(id)) App.livePins.delete(id); // deleting the current element mid-iteration is safe
  }
  while (App.livePins.size > MAX_PINS) App.livePins.delete(App.livePins.values().next().value);
}
```

This is eviction order, not pruning: nothing is dropped while under the cap, so the
resume-friendliness the no-pruning decision buys is untouched.

### Ordering

In `renderLive()` (`web/app.js:1500`), after the existing `if (App.liveSort === "name")` /
`else if (… === "context")` block produces `ordered`:

```js
// Pinned cards lead, each group still in the order the selected sort produced. Skipped
// entirely when nothing is pinned, so "status" keeps rendering the server order verbatim.
if (App.livePins.size) {
  const pinned = [], rest = [];
  for (const s of ordered) (App.livePins.has(s.sessionId) ? pinned : rest).push(s);
  ordered = pinned.concat(rest);
}
```

Because the partition runs last and unconditionally, a pinned card outranks a `waiting` one
in `"status"` mode — see the `(diverges)` decision above. In `"name"` and `"context"` modes
nothing changes on this point: neither ever floated `waiting`.

`ordered` is already a copy in every branch — `sessions` itself comes from `.filter()`, and
the two sort branches call `.slice()` — so the partition never mutates `App.state`.

### The control

In `cardHTML()`, between `headTitleHTML(s)` and the conditional focus button, so the
always-present control holds a stable position and the optional one follows it — and gated
on `App.liveShow.pin`, a sixth member of the existing per-browser row-visibility family
(default on, reusing the generic `set-show-*` handler, so it costs one Settings row and no
new plumbing):

```js
const pinned = App.livePins.has(s.sessionId);
`<button class="pin-btn${pinned ? " pin-btn--on" : ""}" type="button"
   data-pin-session="${esc(s.sessionId)}" aria-pressed="${pinned}"
   title="${pinned ? "Unpin" : "Pin"} this session — pinned cards sort first">${PIN_SVG}</button>`
```

`PIN_SVG` is a new inline glyph beside `TERMINAL_SVG` / `BRANCH_SVG` / `TITLE_SVG`, drawn to
match their flat 13–14px stroke style, with a filled variant selected by `.pin-btn--on`.

Bound in `renderLive()` next to the existing `.focus-btn` binding:

```js
cards.querySelectorAll(".pin-btn").forEach((btn) =>
  btn.addEventListener("click", () => toggleLivePin(btn.dataset.pinSession))
);
```

`.pin-btn` reuses `.focus-btn`'s rule block wholesale (transparent, `--ink-2`, `flex: none`,
hover lifts to `--ink` on `--surface-2`); `.pin-btn--on` overrides to full-strength `--ink`
and swaps the glyph to its filled form.

### Re-render cadence

`renderLive()` rebuilds `cards.innerHTML` on every SSE frame with no signature guard, so
pinned order is re-derived each frame for free and `toggleLivePin` re-rendering directly
matches how `setLiveSort` and `setLiveShow` already behave.

### Edge cases

- **A pinned session ends.** Its card disappears with it; the id stays in storage until the
  cap evicts it, and re-applies if that `session_id` is ever resumed.
- **A pinned session is hidden by the zero-token filter.** It stays hidden — the filter runs
  before ordering, and pinning is an ordering concern.
- **The pin control is switched off while cards are pinned.** The pins stay active and keep
  leading the grid — hiding a control is not a destructive action. Turn the switch back on to
  unpin. The Settings description says so rather than leaving it a surprise, per the `/color`
  dot's precedent (`2026-08-25-color-dot-visibility-toggle`).
- **Storage unavailable** (private mode, blocked site data). `loadPref` / `persistPref`
  already swallow this; pins then work for the session and don't persist.
- **A second tab.** Like every other preference here, the other tab picks up the change on
  its next load — `localStorage` events are not currently wired for any pref.

### Docs to update

`docs/ARCHITECTURE.md`'s **Live** bullet enumerates every per-browser Live-card preference
(`App.liveTitle` and its four modes, `App.liveShow.color`, the sort modes). It must gain
`cockpit.livePins` and the card-head pin control, or that list stops being the inventory it
is relied on to be. The same bullet's "`waiting` sessions sort to the top and are highlighted" sentence must be
qualified — pinned cards now precede them. `docs/CONCEPT.md`'s Vision bullet ("**Which
sessions are waiting for me**, surfaced first so nothing stalls unnoticed") needs the same
qualification: it remains true of unpinned cards, which is the whole of the promise once a
pin is an explicit user act. Both edits belong to this change, not a follow-up.

## Alternatives considered

- **Repo-scoped pins** (`repoRoot`). Durable across restarts and free of staleness, but too
  coarse for the main case: it cannot separate two sessions of the same repository, which is
  when a pin is most useful. The existing sort modes already serve "float this project".
- **Daemon-side pins**, persisted in the snapshot and broadcast over SSE. Shares pins across
  browsers, but turns a view preference into server state and adds an endpoint, a config
  surface and a persistence path for something every comparable preference keeps local.
- **Pin transfer to the next session in the same cwd** when a pinned session ends. Would make
  pins survive restarts without repo-scoping, but silently moves a pin to a session the user
  never pinned — magic that is hard to reason about and worse than re-pinning.
- **Pruning stored pins against the live session set.** Keeps storage exact, but discards a
  pin on any session you later `--resume`, and misbehaves in the window where the live list
  is briefly empty. The cap achieves bounding without either failure.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Single agent, Opus 5.** Three edits in `web/app.js` (`init`, `renderLive`, `cardHTML`)
  plus one `.pin-btn` block in `web/styles.css`, one Settings row, and the two doc
  amendments in *Docs to update* — all on one code path and mutually
  dependent — the class names, the `Set` they toggle and the partition that reads it are a
  single thread, so parallelism would only produce conflicts.
- **Opus 5 rather than Sonnet, for the docs rather than the code.** The JS and CSS are
  transcription — every decision is settled and each reuses a pattern already in the file
  (`.focus-btn`, `cockpit.liveShow`, the existing sort branches). But this change amends
  `docs/CONCEPT.md` and `docs/ARCHITECTURE.md`, which the root `CLAUDE.md` treats as the
  source of truth, and qualifying a Vision-level promise without over- or under-stating it
  is judgment work. Same agent does both, so it takes the higher tier.
- Verification is browser-driven per `web/CLAUDE.md`, not a unit suite — `web/` has no test
  framework.
