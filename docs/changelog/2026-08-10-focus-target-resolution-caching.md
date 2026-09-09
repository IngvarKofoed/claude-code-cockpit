# Terminal focus target resolved once and cached

A session's controlling terminal is resolved ONCE and the MISS is cached too (v0.35.0) — a
headless session (launchd agent, `ps` reports `??`) would otherwise re-fork `ps` on every event.
Skipped during boot replay, which would fork per log line; a post-replay sweep covers restored
sessions instead, so an idle one gets its button at boot rather than hours later on its next event.
Cards receive only a derived `focusable` bool — the tty stays server-side.

<!-- entry 92 -->
