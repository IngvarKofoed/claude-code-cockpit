# Named session groups on the Live page

Replace the flat pin set with **named groups**: a session is added to a group, each group
renders as a bounded box at the top of the Live grid, and each group chooses whether it
grows **down** (one card wide, cards stacked) or **across** (a band of card tracks). Group
membership identifies the *terminal seat* rather than the session id, so a group survives
`/clear` — the case pinning fails. Still entirely client-side: no daemon change, no new
endpoint, no state on disk beyond one `localStorage` key.

## Outcome

**What you get:**

- Named groups at the top of the Live grid, each set to grow down (a stacked column) or across
  (a band), holding its cards in an order you set and can change.
- A group keeps its cards across `/clear` — the cleared session rejoins its own group with
  nothing to re-add.
- Each group shows at a glance whether anything inside it needs you: a status rail like a
  card's, escalating to a tinted border when a member is waiting or has errored.
- Existing pins arrive as one group called "Pinned", and with no groups defined the grid
  renders exactly as it does today.

**How to verify:**

- Put two cards of one repository into a new group and leave it vertical: they stack inside a
  bounded, named box above every ungrouped card, in the order you added them. "Move up" in the
  picker swaps them, and that order survives a reload along with the name and orientation.
- `/clear` one of those two sessions: its card stays in the group, in the same position,
  without being re-added — and it stays visible through the idle, zero-token moment right
  after the clear.
- Set a second group to horizontal while the first stays vertical: the two boxes sit side by
  side rather than each taking its own row.
- Let a grouped session hit a permission prompt: that group's rail goes amber and its border
  tints, and both clear when you answer. Delete every group and the grid is identical to
  today's in all three sort modes.

## Key decisions

- **Groups replace pinning outright** (breaking). `App.livePins` and `cockpit.livePins` give
  way to `App.liveGroups` / `cockpit.liveGroups`; the card-head pin button becomes a group
  picker. One concept, not two competing for the same button and the same top-of-grid space.
  Existing pins migrate into a single group (see *Storage*), so nobody loses their pins.
- **A member is a seat, not a session** (new). Each member is `{ sid, pid, root }` and matches
  a live card if **either** the session id matches **or** `ownerPid` + `repoRoot` both match.
  `/clear` keeps the pid and mints a new sid; `--resume` keeps the sid and mints a new pid —
  holding both keys covers both. Both keys are written once and never rewritten. This is the
  whole reason the feature works, and it is entirely invisible: **no pid, sid or session id is
  ever rendered anywhere in the UI.**
- **Group membership overrides the zero-token filter** (diverges). A grouped session is drawn
  even when idle with 0 tokens. This reverses `2026-09-09-live-card-pinning.md`'s "Pinning
  does not override visibility" — deliberately, because a just-`/clear`ed session is idle at
  0 tokens, so under the old rule the card blinks out of its group and returns elsewhere,
  which is precisely the bug this feature exists to fix. The exemption is scoped to
  membership, not a relaxation of the filter (`2026-08-04-zero-token-session-filter`). Cost: a
  grouped session you never work stays on the grid.
- **Order inside a group is user-controlled; group boxes are in creation order** (diverges).
  The active Live sort orders the ungrouped grid only. It never orders cards *within* a group —
  you put spec first, so spec stays first, through every status change — and it never reorders
  the boxes, so a named group holds a stable screen position, which is most of what the
  feature is for. Pinning let the sort order its bucket; this does not. Members start in
  placement order and are reordered with move up / move down (see *The control*).
- **The group box carries its members' status on a rail, and escalates to the border**
  (extends). The box gets a `.group__rail` mirroring `.card__rail` — amber waiting, red error,
  green running, neutral otherwise — so a group reads at a glance the way a card already does.
  Waiting and error **additionally** tint the box border, reusing `.card--waiting`'s treatment;
  running does not. Precedence is **waiting > error > running > idle**. This is the one place
  the project's "status hue belongs to the rail and badge alone" rule is extended to a new
  surface, and it is extended by *reusing the rail*, not by inventing a second language.
- **The picker reuses the existing `.menu`** (extends). `openRepoMenu` / `closeMenu` /
  `onDocClickForMenu` (`web/app.js:2162`) already own anchoring, viewport clamping, outside-click
  and scroll/resize dismissal, and `.menu__item` / `.menu__item--danger` already have styling.
  The group picker is a second caller; `onDocClickForMenu`'s hardcoded `.repo-menu-btn`
  selector is generalised to serve both.
- **A new group is named after the session's repo, then renamed inline** (new). "New group" in
  the picker creates a group named for that card's `repoName` and drops the card in it
  immediately — no dialog, no empty-name state. The header name is an inline `<input>` that is
  borderless until hovered or focused.
- **Per-browser `localStorage`, never daemon config** (reuses). `cockpit.liveGroups` alongside
  `liveSort` / `liveTitle` / `liveShow` / `theme`. The pinning spec rejected daemon-side pins
  for turning a view preference into server state; that rejection still binds.
- **With no groups defined, the grid renders exactly as today** (reuses). The whole groups
  region — boxes, headers, the "Ungrouped" lane — is skipped when `liveGroups` is empty, and
  `#cards` keeps its own grid untouched, so every sort mode renders byte-identically to now.

## Goals

- Keep the two halves of a two-session workflow adjacent on the grid, across `/clear`.
- Let a user name what a group *is*, so the grid reflects their workstreams rather than sort order.
- Let each group pick the axis that suits it — a pair reads better as a column than as a row.
- Keep a group's internal order stable and under the user's control.
- Let a group say at a glance whether anything inside it needs attention.
- Change nothing about the grid until the user creates a group.

## Non-goals

- **Shared or cross-device groups.** Per-browser, like every other Live preference.
- **A session in more than one group.** One group per session; adding to a second moves it.
- **Drag-and-drop reordering**, and any reordering of the *groups* themselves. Cards within a
  group reorder with move up / move down; group boxes stay in creation order.
- **Pinning inside a group.** Reordering covers the need; a float-to-top flag would reintroduce
  the second card-level concept this change removed, and is only a swap in a two-card group.
- **Rule-based / automatic grouping** (e.g. "everything in repo X"). Membership is explicit.
- **Grouping anywhere else.** The Sessions and Repos tables are untouched.
- **Surviving a `claude` relaunch in the same tab.** That mints a new pid *and* a new sid, so
  the seat is genuinely gone; see *Edge cases*.

## Design

### Storage

```js
App.liveGroups = [
  { id: "g-1a2b", name: "castles pair", orient: "v",
    members: [ { sid: "441762cb", pid: 42383, root: "/Users/ingvar/private/castles" }, … ] },
];
```

Persisted at `cockpit.liveGroups` as JSON, in group order (creation order). Loaded in `init()`
beside the existing pref reads, guarded like `cockpit.liveShow` (`web/app.js:3131`) — but
**repairing per field rather than dropping a record**: a missing `id` is minted, an
unrecognised `orient` defaults to `"v"`, and only the offending *member* is dropped. A group
survives as long as it has a usable `name` and `members` array. Dropping a whole group on one
bad field would silently destroy a named group and its membership, which is not recoverable.
A load that repaired something is **not persisted back** until the user next changes
something, so a transient bad read can't overwrite a good stored value.

**Migration.** When `cockpit.liveGroups` is absent and `cockpit.livePins` is present, the pin
array becomes one group — `{ id: <minted>, name: "Pinned", orient: "h", members: pins.map(sid => ({ sid, pid: null, root: null })) }`.
Horizontal, because that is how pinned cards read today. The old key is **read, never written
or deleted** — leaving it costs nothing and keeps a downgrade working, per the
`usageWeeklyLookbackHours` precedent of letting a retired key simply fall out of use.

### Resolving membership

Matching runs over the **unfiltered** `App.state.sessions`, before `renderLive`'s
idle-and-zero-token filter, so the filter can be made to skip a grouped session (see
*Rendering*). A member matches a card when `m.sid === s.sessionId`, or when
`m.pid != null && m.pid === s.ownerPid && m.root === s.repoRoot`.

Three rules keep the mapping one-to-one, which "one group per session" requires:

- **A session joins the first group holding a matching member**, groups scanned in order.
- **A member binds at most one card.** Two live cards can match one member — during the
  `/clear` overlap the old session (matching by sid) and the new one (matching by pid) are
  both live until `SessionEnd` or the reaper lands. The **sid match wins**; the other card
  falls through to the ungrouped remainder for those few seconds.
- **Within a group, a sid match beats a pid match**, so a resumed session claims its own
  member rather than a sibling's.

A member's `sid` and `pid` are written when the member is added and **never rewritten**. An
earlier draft refreshed `sid` on a pid match; that was dropped — a `--resume` of the old
session is *that session*, which the pinning spec deliberately kept matching, so the refresh
guarded nothing while adding a write on the render path (and, during the overlap above, an
alternating write every SSE frame).

`ownerPid` is already on the card payload (`toCard`), so this needs no daemon change — subject
to the Windows caveat in *Edge cases*.

### Rendering

In `renderLive()`:

1. Resolve membership over the unfiltered session list.
2. Apply the existing idle-and-zero-token filter, **skipping any session that matched a
   member**. The `if (!sessions.length)` empty-state check runs over this post-exemption list,
   so a grid of nothing but grouped zero-token sessions renders its groups rather than
   "No active sessions".
3. Run the existing sort branches over the **ungrouped remainder** only, producing `ordered`.
4. Emit, inside `#cards`: a `.groups` flex container holding one `<section class="group group--v">`
   or `.group--h` per **non-empty** group in creation order, each group's cards in member
   order; then, when the remainder is non-empty, the "Ungrouped" lane header and a `.cards-grid`
   for `ordered`.

`#cards` (`web/index.html:58`) *is* the grid container today — it carries `display: grid` and
the `auto-fill` tracks. While groups exist it takes a `cards--grouped` modifier that drops it
to block flow, so the nested regions lay themselves out; with no groups the modifier is absent
and the element is byte-identically what it is now.

A vertical group is one card track wide with a single-column inner grid; a horizontal group is
a band using the same `auto-fit` track rule as the main grid. Both sit in one wrapping flex
flow, so a vertical and a horizontal group **sit side by side** rather than each claiming a
row. The vertical track keeps `.cards`' documented **420px** floor plus the group box's own
chrome — `web/styles.css:553` records that 420px was chosen to hold the card's stat row, and a
narrower grouped card would break that row before an ungrouped one. Browser verification may
show a narrower track holds the row; if so, record the measured floor in that comment rather
than leaving the two numbers unexplained.

An **empty group is kept in storage but not drawn**, so "castles pair" survives a reboot and
its cards slot back in without leaving a dead box on the grid.

### Group status colour

The box carries a `.group__rail` taking its colour from the most urgent member under
**waiting > error > running > idle**, mapping to the same `--st-*` tokens `.card__rail` uses. The
edge depends on orientation: a **horizontal** group carries it on the left, like a card; a
**vertical** group carries it across the **top**. Stacked cards each have their own left rail, so a
group rail on that edge would sit parallel to them — two vertical colour bars a few pixels apart,
both claiming to mean status. On the top edge it reads as the group's own header accent, and the
stacked cards get the 4px back. On **waiting** and **error** the box border additionally tints, reusing
`.card--waiting`'s border-colour (`web/styles.css:585`) — **border tint only, no glow**: the
glow stays a card-level cue, so a waiting card inside a waiting group reads as "box tinted,
card lit" rather than two concentric halos. Running takes the rail alone.

The precedence deliberately puts **error above running** where `aggregate.statusRank`
(`scripts/aggregate.js:557`) does not — that function ranks running 1 and error 2, because it
orders *cards* by who needs you soonest. A group rail is an alert surface, where a failed
session is more noteworthy than a working one, so the two orderings differ on purpose.

Two consequences, both accepted:

- **Green is on most of the time.** A group holding any running session shows a green rail, so
  the colour is close to ambient rather than informative. It is kept because a group should
  read like a card, and a card's rail is green while it works. Confining green to the *rail*
  while amber and red also take the border is what keeps the exceptional states louder than
  the ordinary one — the escalation, not the hue, carries the urgency.
- **It partly reclaims a known regret.** `2026-09-09-live-card-pinning` accepted that a blocked
  session can sit below the pinned block with no global cue, because the ribbon's Waiting tile
  was removed (`2026-07-30-live-ribbon-totals-tiles`). An amber group rail is a per-group
  version of that cue. It is not a replacement: an *ungrouped* waiting card still has none.

### Re-render safety

`renderLive()` replaces `cards.innerHTML` wholesale on every SSE frame, with `PostToolUse`
pushes coalesced at ~4/s/session. Two new controls live inside that region and cannot survive
a blind rebuild:

- **The group-name input.** A rebuild mid-keystroke would wipe the value, the caret and focus.
- **The open picker.** `renderReposTable` calls `closeMenu()` on re-render because the menu is
  anchored to a button the rebuild destroys; doing that here would slam the picker shut ~4×/s,
  and *not* doing it leaves a menu pointing at a dead node.

So `renderLive` **defers its rebuild** while the groups region holds `document.activeElement`
or the picker is open, re-applying it as soon as focus leaves or the menu closes. A skipped
frame is invisible: timers tick client-side from server anchors, so a card's numbers are not
frozen by a deferred rebuild. After any rebuild the picker button is re-focused with
`preventScroll`, exactly as `toggleLivePin` already does (`web/app.js:1710`) — its own action
rebuilds the grid it lives in, so without this a keyboard user lands on `<body>`.

### The control

The card-head button (still in the same slot beside Focus) opens the picker on every click —
one button, one behaviour. Its Settings row is relabelled **"Show group button"** while the
stored key stays `liveShow.pin`: renaming the key would need a migration and would silently
re-enable the button for anyone who had turned it off. The menu lists:

- **every group, including empty ones**, the current one marked; choosing another **moves** the
  card, appending it to the end of the target group;
- **Move up** and **Move down**, when the card is in a group with more than one member —
  a splice on the members array, disabled at the ends. They live in the picker rather than as
  buttons on the card, so reordering costs no new hit targets in an already-tight card head;
- **Remove from group**, when the card is in one; re-adding later appends rather than
  restoring the old position;
- **New group**, which creates one named after the card's repo and adds the card. It starts
  **vertical** — the pair case reads better as a column, and a one-card group looks identical
  either way.

Listing empty groups is what keeps them reachable: an empty group has no header, so adding any
card to it is how you get its rename, orientation and delete controls back.

Group header controls, left to right: the inline name `<input>`, and — pushed
right — a two-button orientation toggle (`aria-pressed`) and a delete-group button. Deleting
goes through the existing `showConfirm` (`web/app.js:2198`) rather than a native `confirm()`,
and only ungroups its members; it touches no session data.

The button's pinned-style fill (`.pin-btn--on`) now means *this card is in a group*. Fill, not
hue — the status palette is spent on the rail/badge semaphore and the accent blue reads as a
meter level, exactly as the pinning spec settled.

### Bounds

`MAX_GROUPS = 12` and `MAX_MEMBERS_PER_GROUP = 12`. Exceeding either is refused with a `toast`
naming the limit, not silently ignored; the group-limit toast points at deleting a group,
including the empty-group recovery above. Deliberately **per-group** rather than one global
cap: members live in per-group arrays with no global ordering, so a cross-group "oldest member"
has no well-defined answer, and eviction could silently empty a group the user is looking at.
Twelve groups of twelve is already bounded, so nothing is evicted automatically — membership is
explicit in and explicit out.

### Edge cases

- **Windows without a verified owner pid — an accepted limit.** `aggregate.js:172` captures
  `owner_pid` from every event unless the session is `ownerPidVerified`, and on Windows every
  event's `owner_pid` is a throwaway per-hook shell. ARCHITECTURE records a known gap where the
  probe never verifies (an npm/global install: `claude.cmd → node.exe`), and `toCard` deletes
  `ownerPidVerified` (`aggregate.js:547`), so the client cannot tell a durable pid from a
  churning one. On such a session the stored pid goes stale within seconds and `/clear`
  survival silently does not work — the group simply loses the card, which is pinning's
  behaviour and no worse than today. Accepted deliberately to keep this change **entirely
  client-side**: the fix is to ship `ownerPidVerified` (or a derived seat key) on the card
  payload and pid-match only on a verified pid, which is a small daemon change available later
  if Windows users hit it. `process.ppid` on macOS and Linux *is* the durable `claude`
  process, so the primary platforms are unaffected.
- **`claude` relaunched in the same tab.** New pid *and* new sid, so the member no longer
  matches and the group is one card short until the user re-adds it. Only the tty survives
  this, and the daemon deliberately keeps focus targets out of the browser
  (`2026-08-11-focus-target-abstraction`), so there is no key available to the client.
- **A recycled pid.** The OS can reissue a dead pid to an unrelated session, which would then
  match a stale member. Bounded by requiring `repoRoot` to match too; the consequence if it
  slips through is a card in the wrong group, not a wrong action.
- **An already-hidden session cannot be grouped.** The zero-token exemption is scoped to
  membership, so a session that is *already* idle at zero tokens has no card, no group button,
  and no way in. The exemption can therefore only preserve a membership, never create one —
  which is exactly what the `/clear` case needs (you group the session while it is working, and
  it stays grouped once cleared). Confirmed in a browser against a forged zero-token session.
- **A grouped session ends.** Its card disappears; the member stays, so the group refills when
  that seat comes back. Nothing prunes it — the same no-pruning rule pins follow.
- **A second tab.** `liveGroups` is only written on a deliberate user action (add, move,
  remove, rename, re-orient, delete), never automatically, so the pinning spec's last-writer-
  wins cost is unchanged: the other tab picks up the change on its next load.
- **The group button is switched off with groups defined.** Groups keep rendering; only the
  control is hidden. Same rule as pins, and the Settings description says so.
- **Storage unavailable** (private mode). `loadPref` / `persistPref` already swallow it;
  groups then work for the session and don't persist.

### Docs to update

`docs/ARCHITECTURE.md`'s **Live** bullet inventories every per-browser Live-card preference and
currently describes `cockpit.livePins` and the pin control — it must describe groups instead,
including the orientation choice and the visibility divergence. `docs/CONCEPT.md`'s Vision
bullet qualifies "waiting sessions surfaced first" with "except beneath pinned cards"; that
qualification now reads "grouped". Both edits belong to this change, as they did to pinning's.

## Alternatives considered

- **Keep pinning and add groups beside it.** Two concepts competing for one card-head button
  and the same top-of-grid real estate, with no answer for a card that is both.
- **Rule-based groups** ("everything in repo X"). Zero assignment effort, but can't name a
  workstream, can't span repos, and can't separate two sessions of one repo — which is the
  case here. Available separately as a repo-grouping sort mode if it's ever wanted.
- **Daemon-side groups** broadcast over SSE. Shares groups across browsers, but turns a view
  preference into server state plus an endpoint and a persistence path — rejected once already
  in `2026-09-09-live-card-pinning.md`.
- **Session-id-only membership** (today's pin key). Simplest storage, no pid semantics — and a
  group empties itself on every `/clear`, which is the problem being solved.
- **Slots**: a group holds named roles ("spec", "implement") and a session binds to a slot.
  More expressive and would survive a relaunch by re-binding, but it asks the user to model
  their workflow before they get any benefit.
- **Refreshing a member's `sid` on a pid match.** Dropped during review — see *Resolving
  membership*.
- **Shipping `ownerPidVerified` on the card payload** so pid matching is correct on Windows
  too. Rejected for now to keep the change entirely client-side; recorded in *Edge cases* as
  the fix to reach for if it bites.
- **An amber-and-red-only group rail, with no green.** Argued on the grounds that green is the
  modal state and so carries little information, and that `2026-08-30-meter-accent-blue-fill`
  already moved meters off running-green to stop them reading as status lights. Decided
  against: a group should read like a card, and a card's rail is green while it works.
  Confining green to the rail while amber and red also take the border is the compromise that
  keeps the exceptional states louder. **Do not re-litigate** — this was raised and settled.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Single agent, Opus 5.** One thread in `web/app.js` — the stored shape, the matcher, the
  `renderLive` partition, the re-render deferral and the picker all read each other's
  invariants — plus a `web/styles.css` block coupled to the class names that JS emits. Nothing
  here splits into streams that wouldn't collide. `web/index.html` is untouched: `#cards` gets
  its `cards--grouped` modifier from JS.
- **Opus rather than Sonnet, for the judgment rather than the volume.** Three parts are
  interpretation, not transcription: the one-card-per-member binding during the `/clear`
  overlap, the re-render deferral (a wrong guard either freezes the grid or eats keystrokes),
  and the `docs/CONCEPT.md` / `docs/ARCHITECTURE.md` amendments the root `CLAUDE.md` treats as
  source of truth.
- Verification is browser-driven per `web/CLAUDE.md` — `web/` has no unit framework. The
  `/clear` path needs a real second session, not a synthetic event. Lands with its own
  `docs/changelog/` entry citing `2026-09-09-pinned-live-cards` for the two reversals.
