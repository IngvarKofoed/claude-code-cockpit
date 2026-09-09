# Retiring a spent pid target releases the resolve latch

Retiring a spent `pid:` target now RELEASES the resolve-once latch too (v0.41.0, review fix).
Entry 130 nulled the target but left `focusAttempted` set, and nothing else can re-derive an
ancestor-derived one — a VS Code host is deliberately off TERMINAL_IMAGES, so the title
fallback cannot rescue it. One transient no-window click therefore made a session permanently
buttonless: entry 110's bug shape, reintroduced. Re-arms per failed CLICK, never per event.

<!-- entry 131 -->
