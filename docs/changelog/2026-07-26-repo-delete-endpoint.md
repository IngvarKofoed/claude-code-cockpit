# Delete-a-repo endpoint hard-deletes one repo's accounting

Delete-a-repo. `POST /api/repos/delete {repoRoot}` hard-deletes one repo's accounting across every
usage/event/rollup day-file, unlinking emptied files so the store actually shrinks. Refuses with `409` if a
live session owns the repo (its in-flight events would otherwise re-populate it). The current-day event log
is rewritten too, and its tail byte-offset reset to the shrunk size, so the next tail can't re-read and
double-count the OTHER repos' live state (the sharp edge — a naive shrink would trip the size<offset
"truncated→restart-from-0" path). Triggered from a ⋯ menu on the Per-repo page behind an in-app confirm.

<!-- entry 29 -->
