# Focus handle unified into a platform-neutral focusTarget

The per-session focus handle is now the platform-neutral `session.focusTarget` — a tty
(`/dev/ttys004`) or a window pid (`pid:1234`) — replacing `session.tty` (v0.36.0).
`focusTarget()` dispatches on the value's SHAPE, not the running platform, so a target
from another machine's snapshot fails a shape check instead of reaching the wrong OS
command. A pre-0.36 snapshot's `tty` is migrated on load and the old key DELETED: `toCard`
spreads the session, so a lingering field would have reached the browser.

<!-- entry 94 -->
