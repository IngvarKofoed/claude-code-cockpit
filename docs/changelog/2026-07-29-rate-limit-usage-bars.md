# Live ribbon shows account-wide rate-limit usage bars

Live page now shows account-wide rate-limit usage — a Session (5h) + Week bar on the ribbon, fed by an
OPT-IN statusline forwarder that POSTs only `rate_limits` to a new `POST /internal/usage` (behind the
existing bearer/origin gate). ONE global snapshot (rate limits are account-wide, so every session reports
the same numbers), served on `/api/state` `usage` and persisted in the snapshot. Source is the Claude Code
statusline payload — the only LOCAL carrier of this data (hooks/transcripts don't have it and we never call
the API). The 5h bar carries a pace cue (a tick at elapsed-% + a signed burn-rate delta), settable via a new
`usagePace` config (`both`|`tick`|`delta`|`off`); it is FROZEN once a bar goes stale so a moving delta can't
animate an ever-more-wrong "under pace" against known-stale data. Honest degradation (the "no wrong zero"
rule): no snapshot → an "install the statusline" affordance, never a fake 0; a passed reset → "reset •
awaiting update"; a >10-min-old snapshot → dimmed "updated Xm ago". Only `five_hour`+`seven_day` aggregate
exist (NO per-model bar), and only for Pro/Max after the first API response. The daemon broadcasts only when
the numbers actually CHANGE (the forwarder posts on every render — an unchanged push must not rebuild the
Live grid). Normalization (resets_at seconds→ms, used_percentage clamp 0–100, malformed-body drop, per-window
independent) is the pure, unit-tested `scripts/usage.js`; the module-level snapshot var is `rateLimitUsage`
(named distinctly from the file's many local `usage` vars so a dropped `let` can't clobber it).

<!-- entry 42 -->
