# Exhaustion clause renders only when reading over pace

That clause renders ONLY when the delta's own signed gap + tolerance band reads over pace, so
the two cues on a bar can never contradict each other. That test is also algebraically "the
projection lands before the reset" (timeLeft < timeToReset ⟺ elapsedFrac < usedFrac), only
stricter — so under pace it renders nothing at all, replacing entry 53's "won't run out" text,
and at the cap nothing, leaving the multiplier's "at limit" the sole exhausted-state cue.

<!-- entry 153 -->
