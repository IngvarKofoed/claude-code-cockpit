# Live cards gather into named groups that survive /clear

Session cards can now be put into **named groups**, each a bounded box leading the Live grid and
growing down (a stacked column) or across (a band), holding its cards in an order you set with
Move up / Move down. A group identifies the **terminal seat** — `ownerPid` + `repoRoot` as well
as the session id — so `/clear`, which mints a new session id, no longer empties it. Replaces
pinning entirely; existing pins migrate into one "Pinned" group.
Spec: `docs/specs/2026-09-16-live-card-groups.md`.

## Detail

- **Why the seat key exists at all.** Pinning was keyed on `sessionId` alone, and `/clear` mints a
  new one — measured in this repo's own event log: owner_pid 15802 produced six session ids in a
  day, 11042 four. That is the whole reason for the pid half. It is never rendered; the
  `pid · sid` strip that appeared in the design mockup was scaffolding and is not in the product.
- **Two reversals of `2026-09-09-pinned-live-cards`.** (1) A grouped card is now **exempt from the
  idle-and-zero-token filter**, where that entry stated "pinning does not override visibility" —
  a just-cleared session is idle at zero tokens, so under the old rule it blinked out of its group
  and came back elsewhere, the exact bug groups fix. The exemption is scoped to membership, never
  a relaxation of the filter (`2026-08-04-zero-token-session-filter` still binds). (2) The active
  sort no longer orders cards **within** a group; placement order wins there.
- **Consequence of (1), accepted:** a session that is *already* hidden has no card and so no
  button, so the exemption can only preserve a membership, never create one. You group a session
  while it is working; it stays grouped once cleared.
- **The group rail keeps green**, which was argued against and overruled: green is the modal state
  and so close to ambient, and `2026-08-30-meter-accent-blue-fill` had already moved meters off
  running-green. Kept because a group should read like a card, and a card's rail is green while it
  works. The compromise is that **only** waiting and error also tint the box border, so the
  exceptional states stay louder. **Do not re-litigate.**
- **A vertical group's rail sits on the TOP edge, a horizontal group's on the left.** Stacked cards
  each carry their own left rail, so a group rail on that edge ran parallel to them — two colour
  bars a few pixels apart, both claiming to mean status. Across the top it reads as the group's own
  header accent instead, and the stacked cards recover the 4px.
- **Rail precedence is waiting > error > running**, deliberately unlike `aggregate.statusRank`,
  which ranks running above error: that function orders *cards* by who needs you soonest, while a
  group rail is an alert surface where a failed session outranks a working one. The rail is
  redundant with the member cards' own status badges, so status is never colour-alone.
- **`renderLive` now defers its rebuild** while the groups region holds focus or the picker is
  open. It replaces `cards.innerHTML` wholesale several times a second, which would otherwise wipe
  a half-typed group name (value, caret and focus) and leave the menu anchored to a dead node. A
  skipped frame is invisible — timers tick client-side from server anchors.
- **Storage repairs per field, not per record.** A flat `string[]` had nothing to lose; a nested
  group carries a name and a membership that one bad value would silently destroy. A repaired load
  is not persisted until the user next acts, so a transient bad read can't overwrite a good value.
  An absent `cockpit.liveGroups` migrates `cockpit.livePins` (read, never written or deleted); a
  present-but-unreadable one starts empty rather than resurrecting dead pins.
- **Caps are per group** (12 groups × 12 members), refused with a toast. Deliberately *not* one
  global cap with age-based eviction: per-group arrays have no global ordering, so "oldest member"
  has no defined answer, and eviction could silently empty a group you are looking at.
- **Rejected:** an intra-group pin (reintroduces the second card-level concept this removed, and is
  only a swap in a two-card group); drag-and-drop reordering; shipping `ownerPidVerified` on the
  card payload to make pid matching correct on Windows — deferred to keep this entirely
  client-side, and named in the spec as the fix if it bites.
- **Known limit:** on Windows an unverified `owner_pid` is a throwaway per-hook shell
  (`aggregate.js:172`; `toCard` strips `ownerPidVerified`), so `/clear` survival silently does not
  work there. `process.ppid` on macOS and Linux *is* the durable `claude` process.
- **Group chrome is 18px, not 30px** (4px rail + 2×6px side padding + 2×1px border). At 12px a side
  a vertical group was 450px wide, so three needed 1374px against the 1356px content column and
  wrapped to two — where three plain cards fit. Side padding is deliberately tighter than the block
  padding: the box's chrome is pure overhead against the card track inside it.
- **Fixed before landing, found by review:** `renderLiveRibbon()` ran *below* the render-deferral
  guard, so today's totals froze while a picker was open or a name was being typed; `groupStatus`
  used `effectiveStatus`, showing a green rail on a group whose cards all read "Paused"; a blurred
  rename left an emptied field showing a name that was never stored; and rebuilding on blur
  detached the control under an in-flight mousedown, swallowing the first click after a rename.
- **Also fixed: a refused move destroyed the old membership.** `groupAddSession` removed the card
  from its current group *before* the cap check, so adding to a full group dropped it to the
  ungrouped grid with only a toast. The cap is now checked first, and re-picking the group a card
  is already in is a no-op rather than a remove-and-re-push that silently moved it to the end.
- **Also fixed: Move up / Move down stepped by raw member index.** A group keeps the seat of a
  session that has ended, so with a dead member between two live cards a click swapped a visible
  card with an invisible member — persisted, repainted nothing, read as a dead button; "Move down"
  could also be enabled on the card already last. Both now step through the members that actually
  have a card this render (`boundMemberIndices`) and **swap** rather than splice, so a seat that
  comes back lands where it was left.
- **Also fixed: the render deferral could hold indefinitely.** `document.activeElement` survives the
  window losing focus, so a group name clicked into and then alt-tabbed away from froze the whole
  card grid on a stale status and activity line while its timers kept ticking from stale anchors.
  The name input now blocks the rebuild only while `document.hasFocus()` — nobody types into an
  unfocused document, and every keystroke is already persisted, so the rebuild re-renders the
  stored name. Do not restore the unconditional block.
- **Also fixed:** the group button lost its state to screen readers when `aria-pressed` went away
  with the pin toggle — it opens a menu, so the *label* carries it ("Session group: X") rather than
  a constant name plus a `title` the accname algorithm treats as a last resort. And the
  group-limit toast said "delete one", which can name a box that isn't drawn; it now names the
  recovery (add a card to a group, then delete it).
- **Verified** against a throwaway daemon on an isolated `XDG_STATE_HOME`, driving the real
  `/clear` sequence through the event log: with both sessions live the member bound exactly one
  card (the sid match), and once the old session ended the group held the **new** session id while
  the stored member still named the dead one — proving the pid match, and that members are not
  rewritten. The zero-token exemption and the omitted empty lane were confirmed in the same run.
