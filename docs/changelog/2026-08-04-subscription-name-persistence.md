# Usage records persist the subscription's raw name

Usage records now persist `subscriptionName` (the raw base name) alongside the subscription
id, so a recomputed PAST day keeps a real per-subscription label instead of the raw org UUID.
Before, only the id was stored; a subscription used only on a rolled-over day (never live-
ingested with its name within the aggregated range) showed its UUID in History/all-time views
— `mergeSubName` recovered a name only if some other day in the range had it. Closes that seam;
old records lacking the field still fall back to the id (then mergeSubName), so no regression.

<!-- entry 68 -->
