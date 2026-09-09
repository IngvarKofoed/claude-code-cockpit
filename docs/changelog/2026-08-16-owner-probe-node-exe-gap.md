# Owner probe still misses npm/global node.exe installs

Known gap, deliberately left open: the owner probe matches only `claude.exe`, so an npm/global
install (`claude.cmd → node.exe`) gets no durable pid and keeps the ~6h idle reaper. Matching
`node.exe` would cover it but risks verifying an unrelated node process as the host — and a WRONG
verified pid reaps a LIVE session, strictly worse than the pre-probe behaviour. Closing it properly
needs the ancestor's command line to confirm.

<!-- entry 114 -->
