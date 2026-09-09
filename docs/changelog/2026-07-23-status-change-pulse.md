# Cards pulse visibly on every status change

Cards PULSE on a status change to make it noticeable, with the two most important transitions emphasized:
running→idle ("done", a distinct accent-blue pulse — not the muted idle grey) and running→waiting ("needs
you", amber) pulse LONGER (5 cycles, equal length); every other change is one short pulse in the new
status's colour. Reuses the existing `prevStatus` transition detection (a single pass shared with the sound
cues), gated on `soundsPrimed` so the first snapshot / reconnect resync doesn't flash the grid. Keyed by a
per-session `App.flash` = {until, cls} window (not a one-shot set) so the pulse survives the frequent
card-grid re-renders; finite CSS iteration counts mean a lingering class never pulses forever. New sessions
pulse once as a new-card cue; disabled under `prefers-reduced-motion`.

<!-- entry 19 -->
