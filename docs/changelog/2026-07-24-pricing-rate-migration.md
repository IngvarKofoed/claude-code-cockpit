# Config migration upgrades stale persisted pricing rates

One-time config migration: `readConfig` stamps a `configVersion` and, for a config from before the
entry-22 fix, upgrades any rate still equal to its pre-v1 default to the current one — so the Opus 4.8
$15/$75 → $5/$25 correction reaches users who persisted a `rates` map (authoritative per entry 5, so it
otherwise shadows the fix). Match is by value; a changed/removed rate is untouched. Persisted once as the
minimal RAW config (omitted fields still inherit live defaults, not frozen), version-gated so it never re-runs.

<!-- entry 24 -->
