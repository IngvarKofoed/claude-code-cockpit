# Design hardened after external review before any code

Design hardened after an external review (Codex GPT-5.3 + Gemini 3.1 Pro), before any code exists.
Daemon singleton is an exclusive OS lock, not a health-check (avoids TOCTOU double-spawn); logs are canonical with byte-offset idempotency and the open day's rollup rebuilt on boot (crash-safe).
All HTTP/SSE/internal endpoints require a 0600 bearer token + Origin check — localhost bind alone isn't access control on shared machines.
Transcript reads retry for async flush and key usage by message id; stale-reaper keys off the owning PID; SSE resyncs via /api/state on reconnect.
Activity-argument detail (file path / command) is now default-off (`activityDetail`) to preserve the "no message content" guarantee; tool names are always shown.

<!-- entry 2 -->
