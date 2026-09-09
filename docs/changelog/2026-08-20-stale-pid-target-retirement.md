# A no-window pid target is retired on the spot

A `pid:` target that reports `no-window` is now RETIRED on the spot (v0.41.0), so the next sweep
re-derives one instead of leaving a visible button that can only ever fail. Needed by entry 127:
an ancestor pid outlives the session by construction, but a TITLE-derived one names a window that
can close while the session lives — or that a title collision never owned. Found by killing a
matched window and watching the card keep its button across a daemon restart.

<!-- entry 130 -->
