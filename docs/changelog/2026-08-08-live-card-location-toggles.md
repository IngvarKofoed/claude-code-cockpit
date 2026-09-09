# Branch and folder path stack with per-line visibility toggles

Live cards STACK branch + folder path on separate lines (was one shared row), and each location
line — session name, branch, folder path — gets a per-browser show/hide toggle in Settings >
Dashboard (v0.32.0; localStorage `cockpit.liveShow`, all on by default; a malformed/partial stored
value defaults each key on; `.card__where` wrapper dropped when neither line shows). Height reclaimed
for the live grid: topbar ~47→41px (its own padding + nav-tab/button vertical padding, since the
Pause button — tallest child — sets the bar height), main top padding 16→12, ribbon margin 14→12,
card body padding →9px / gap 7px (card grid gap was already 12). Stacking still adds a line by default
— so the lever to fit two card rows is toggling the folder path off (~21px/card, more than this buys).
[Superseded in part: the ribbon margin 14→12 was reverted in 0.32.1 — see entry 85.]

<!-- entry 83 -->
