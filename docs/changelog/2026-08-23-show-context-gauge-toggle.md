# New toggle hides the Live card's context gauge

New per-browser toggle "Show context gauge" (Settings > Dashboard, under Show folder path,
default on) hides the Live card's context meter — worth 23px of card height, the biggest
single lever there. Rides the existing `cockpit.liveShow` pref and its generic
`set-show-*` handler, so it needs no new plumbing and never PUTs config. The "Context %"
live sort is untouched by it: the reading still arrives and still orders the grid.

<!-- entry 144 -->
