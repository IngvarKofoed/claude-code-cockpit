# Usage colour ramp's amber line moved from 50% to 65%

The usage colour ramp's amber line moved 50% → 65% (red stays 80): the warning band is now
the last third of a window rather than half of it. Governs all three meters at once — the
5h bar, the weekly bar, and the per-card context gauge (`web/app.js:usageColor`) — plus the
statusline's own `threshColor`, which duplicates the ramp and must be kept in step.

<!-- entry 143 -->
