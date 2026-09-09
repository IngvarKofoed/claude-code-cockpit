# Statusline renderer and installer shipped under statusline/

Statusline tooling shipped under `statusline/` (colored-line renderer + README + install.sh) — installing it
is what feeds entry 42's usage bars. Install is an ABSOLUTE path written into `~/.claude/settings.json`
`statusLine.command`: verified `statusLine.command` supports NEITHER `${CLAUDE_PLUGIN_ROOT}` NOR a
plugin-shipped top-level `statusLine` (a plugin can only ship `subagentStatusLine`), so it must be re-run
after a plugin upgrade (the install dir is hashed and GC'd ~7 days later). Cross-platform via `node <path>`
(no bash wrapper); `install.sh` is a Unix-only convenience (timestamped backup, idempotent skip-if-ours) and
the manual README edit is the all-OS path. The renderer reads the branch from `.git/HEAD` via `repo.js` (no
per-render `git` subprocess) and fires the best-effort POST only AFTER stdout flushes (a synchronous exit
could truncate a piped status line).

<!-- entry 43 -->
