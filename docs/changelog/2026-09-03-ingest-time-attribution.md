# Closed turns attributed to the account at ingest time

A just-closed turn's usage record is now attributed to the account at INGEST time, not the
session's captured one — closing entry 66's known limit, whose claimed self-heal only ever
covered ended sessions. Earlier-day groups in the same ingest and `/cockpit:backfill` keep
the captured attribution: those tokens were spent at times the live read can't vouch for.

<!-- entry 188 -->
