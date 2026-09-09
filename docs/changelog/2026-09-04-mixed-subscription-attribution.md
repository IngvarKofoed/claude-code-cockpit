# bySubscription history permanently mixes two attributions

That is irreversible and knowingly accepted: post-upgrade closed-turn records carry
live-at-ingest attribution while pre-upgrade and backfill records keep captured/null in the
SAME field with no marker, so the two meanings mix permanently in `bySubscription` history.
No migration (a marker field would be schema for no consumer).

<!-- entry 189 -->
