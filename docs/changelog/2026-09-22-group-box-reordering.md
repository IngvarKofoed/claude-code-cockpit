# Group boxes reorder from the header, not just their cards

A group box can now be moved along the Live grid with a ‹ / › pair in its header, beside the
direction toggle. Boxes previously held **creation order** with no way to change it — only their
cards were reorderable (Move up / Move down in the card picker). Order is per-browser, in the
same `cockpit.liveGroups` record as the name, direction and membership.

## Detail

- **Chevrons point left/right, not up/down**, because `.groups` is a wrapping flex **row**: a box
  travels one slot along the row and wraps at an edge, never one row up. The request was phrased
  as "move up / move down" — deliberately not taken literally, since the arrows would then point
  somewhere the box does not go. The card picker keeps "Move up / Move down" for *members*, which
  is a different list.
- **Steps through the DRAWN boxes, not the raw `App.liveGroups` array** (`drawnGroups()`) — the
  same rule and the same reason as `boundMemberIndices`: an **empty group is kept but not drawn**
  (`2026-09-16-live-card-groups`), so a raw ±1 index shift can swap a visible box with an
  invisible one, which persists a change and repaints nothing. Verified with an undrawn group
  sitting between two drawn ones: the drawn pair swapped and the undrawn group kept its slot.
- **Swap, not splice**, mirroring `groupMoveMember`: an undrawn group between the two keeps its
  own index, so a group that gets a live card back lands where it was left.
- **Outside the `.group__orient` pill, deliberately.** A filled slot in that pill means "this is
  the current direction"; an action living inside it would read as a third selectable state. The
  pair sits bare beside the delete button, which is already bare.
- **Disabled at the ends rather than hidden**, so the cluster never reflows the header (and the
  delete button never shifts) as a box travels. The whole cluster *is* omitted below two drawn
  boxes — the same `bound.length > 1` rule the picker's Move up / Move down follow, rather than
  offering a pair that can only ever be disabled.
- **Reordering changes group precedence in `resolveGroupMembership`**, which joins a session to
  the *first* group holding a matching member. That only matters if two groups both match one
  session, which `groupAddSession` prevents — it is reachable via hand-edited storage or a pid
  collision, and bounded to "a card in the wrong group", never a wrong action.
- **`bucket.get(g.id) || []` guards a coupling the change introduced.** `drawnGroups()` derives
  the box set from `App.groupAssign` while `bucket` is built from the *filtered* session list; the
  two agree only because a grouped session is exempt from the idle-and-zero-token filter. That
  invariant now lives two functions away from the call site, so if it is ever narrowed an empty box
  is a survivable render where `groupStatus(undefined)` would throw out of `renderLive` and blank
  the Live view mid-rebuild.
- **Known limit, pre-existing and not introduced here:** the click handler refocuses the moved
  box's button (the precedent `2026-09-09-pinned-live-cards` set), but any SSE frame landing
  afterwards rebuilds `cards.innerHTML` and drops focus to `<body>` — so a keyboard user pausing
  between presses loses the button. Every control in the grid has this; a general focus-restore
  in `renderLive` would fix all of them and is out of scope for this change. Measured: focus is
  correct synchronously after the click, gone a few seconds later.
- **Verified in a real browser against the live daemon**, both themes: end-disabling correct at
  both ends, the cluster absent with one drawn box, the undrawn-group swap as above, the moved
  box's button refocused, no console errors. Worst case checked — a max-length name in the narrow
  vertical box (424px header) still packs with ~28px slack and the name ellipsizes, no overflow.
