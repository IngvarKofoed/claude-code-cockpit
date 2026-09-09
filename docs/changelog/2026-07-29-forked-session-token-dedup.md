# Forked sessions re-count inherited tokens, fix specced

Documented (not yet fixed) a CONFIRMED accounting bug: a `--fork-session --resume <parent>.jsonl` fork
(Claude Code backgrounding a session) copies the parent's transcript keeping the same message-uuids, but
token dedup is keyed per session_id, so the fork re-counts every inherited message — inflating the shared
repo's tokens/cost. Verified live (parent + fork shared 41 uuids, same repo_root).
Fix is specced at `docs/specs/2026-07-06-forked-session-accounting.md`: dedup on the globally-unique
message-uuid (positional `__idx_*` fallback ids namespaced per-session so they don't false-collide), plus a
symmetric `sharesHistory` badge on the Live card (forks share the parent's name, so twins looked identical).
Active time is intentionally NOT changed — concurrent sessions on one repo correctly sum active time.

<!-- entry 41 -->
