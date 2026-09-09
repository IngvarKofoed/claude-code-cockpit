# Hook payload parsing strips a leading BOM

Two shared modules extracted: `event-log.js` (hook-side append + daemon nudge, so ensure.js can log
events too) and `winproc.js` (PowerShell runner + ancestor walk, shared with the focus chain).
Hook payload parsing now strips a leading BOM — JSON.parse rejects one, which silently degraded a
whole payload to `{}`. Found when a BOM-prefixed test payload made the owner probe skip itself.

<!-- entry 108 -->
