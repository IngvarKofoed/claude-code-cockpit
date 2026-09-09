# Topbar now shows the running daemon's version

The topbar now shows the RUNNING daemon's version after the `● live` indicator, from the
`daemon.version` already on every `/api/state` frame. Makes entry 103's upgrade seam
visible: a stale daemon (or a stale tab) is now readable at a glance instead of needing
`/health`. Written only when a frame carries a version — never a placeholder — so it can't
display a version the daemon isn't on; empty until the first snapshot, and `:empty` hides it.

<!-- entry 147 -->
