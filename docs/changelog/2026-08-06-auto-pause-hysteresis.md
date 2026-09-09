# Auto-pause resume gets a hysteresis deadband to stop flapping

Auto-pause gained a hysteresis deadband so it no longer flaps (v0.25.0). It paused AND resumed at the same
line (`autoPauseFiveHourPct`), so a rolling 5h % wobbling a point or two across the threshold
toggled the gate pause/resume every few seconds (logs showed a Paused 13s after a Resumed). Now it
pauses at the threshold but resumes only once usage falls `threshold − 10` (deadband capped at half
the threshold, so a low threshold keeps a resume line above 0 and never strands paused-forever).
Chosen over "resume only on the window's `resetsAt`": that removes the low-usage escape valve, so a
wrong/stale high push (e.g. a lagging old-subscription statusline slipping past the fail-open sub
filter) that auto-paused you could strand you until the old window reset. Hysteresis keeps the valve
— a real reset (→~0%) or a switch to a lower-usage subscription clears the resume line, so the next
correct low reading resumes; you stay paused only while the CURRENT sub's usage is genuinely high.
Pure `pause.autoPauseDecision` change only (deadband derived from the existing threshold) — daemon
logic unchanged. The banner/timer were never wrong: they tick real-time from a fixed anchor, and a
long elapsed just meant the auto-pilot had paused earlier than the user realized.

<!-- entry 74 -->
