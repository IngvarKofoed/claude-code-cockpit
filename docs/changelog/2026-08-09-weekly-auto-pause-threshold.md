# Auto-pilot watches both 5h and weekly usage windows

The usage auto-pilot now watches BOTH rate-limit windows, each with its own threshold (v0.34.0):
the existing `autoPauseFiveHourPct` (default 90) plus a new `autoPauseWeeklyPct` for the 7-day window.
EITHER crossing pauses. Auto-resume needs no armed window still at/above its threshold AND the
window that TRIPPED back under its hysteresis line. The deadband is anti-flap only, so it applies
solely to the tripping window (tracked per pause span, not persisted): gating on an innocent one
strands the gate — a weekly resting at 85 under a 90 threshold would hold every 5h pause open for days.
A window with no threshold (0) or no reading in a push isn't armed — it can neither pause nor block a resume.
Weekly ships OFF (0), unlike the 5h: that window frees up only as old usage ages out, so a weekly
auto-pause can hold for DAYS — too heavy to impose by default. Arming it while already over pauses
on the next statusline push (a disarmed window keeps no rising-edge memory, by design).

<!-- entry 88 -->
