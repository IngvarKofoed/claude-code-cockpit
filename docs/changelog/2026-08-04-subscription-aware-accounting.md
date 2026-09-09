# Usage accounting becomes subscription-aware

Subscription-aware usage accounting (v0.23.0): every session's `sub` (organizationUuid + label)
is captured once at SessionStart by `emit.js` and embedded in the durable event — replay-safe
when subscriptions change across restarts. Rate-limit bar now drops pushes from sessions on an
OLD subscription (fail-open if either sub unknown), eliminating cross-sub bar clobber. Usage
records + per-repo rollups gain `subscription` as a first-class dimension; daily rollups derive
per-subscription breakdowns on demand from the logs. Dashboard shows all-time `subscriptionTotals`
(mirrors `repoTotals`), a Live active-subscription chip, and a per-subscription History chart.
New `subscriptionLabelPattern` config (regex, default `\(([^)]+)\)` extracts parenthesized name)
relabels subscriptions at payload-build time, never touching stored data — so label changes
re-label history retroactively. Known limit: mid-session subscription switch mis-attributes
until the session ends (self-heals); backfill leaves subscription null (can't recover from
transcript). Fail-open: pre-feature/API-key sessions bucket as "unknown" in stats, never wrong.

<!-- entry 66 -->
