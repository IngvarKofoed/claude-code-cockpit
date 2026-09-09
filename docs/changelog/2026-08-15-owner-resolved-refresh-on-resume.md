# A second OwnerResolved event refreshes a resumed session's pid

A SECOND `OwnerResolved` now refreshes the pid (v0.38.0, review fix). `--resume` reuses the
session_id, so its probe re-reports a new claude.exe — but `updateMeta` refuses to write once
verified, so the record kept the previous run's DEAD pid while still counting as reaper evidence,
reaping a live session. That was entry 101's false reap, reintroduced. The pid is now assigned in
the `OwnerResolved` branch itself rather than deferred to `updateMeta`.

<!-- entry 109 -->
