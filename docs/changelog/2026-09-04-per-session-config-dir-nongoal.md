# Concurrent sessions on different accounts stay a non-goal

Documented non-goal: concurrent sessions on DIFFERENT accounts via per-session
`CLAUDE_CONFIG_DIR`. The daemon reads the default `~/.claude.json`; such a push is accepted
fail-open, bounded by the sample buffers' ≥10-point steep-drop rule.

<!-- entry 191 -->
