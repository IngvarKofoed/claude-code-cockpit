# claude-code-cockpit — scripts (daemon, hooks, core)

The Node.js side of the plugin. Refer to `docs/ARCHITECTURE.md` for the broader context.

Contents: `emit.js` (hook entry — parse stdin, append event, ping daemon, exit 0), `ensure.js` / `ensure-deps.js` (SessionStart: idempotent deps + spawn the daemon), `daemon.js` (the always-on server: aggregate + HTTP + SSE + notify), the pure core modules `aggregate.js` / `transcript.js` / `repo.js` / `pricing.js`, plus `notify.js`, `config.js`, `paths.js`, and `*.test.js`.

## Required tools

- **`LSP`** — use it for symbol navigation, references, and hover across the Node scripts instead of grepping. If deferred, load it first via `ToolSearch` with `select:LSP` (backed by the TypeScript/JavaScript language server).
- **`claude-code-guide`** (agent) — invoke it whenever you touch hook wiring, hook payload fields, plugin mechanics (`${CLAUDE_PLUGIN_ROOT}`, `hooks.json`, `plugin.json`), or the transcript format. It gives authoritative, docs-cited answers on the exact Claude Code surfaces this code depends on, which change between versions. Spawn it via the `Agent` tool; if one is already running, continue it via `SendMessage` rather than starting a new one.

## Testing

Unit tests run with **Node's built-in test runner: `node --test`** — no external framework. The pure modules (`aggregate.js`, `repo.js`, `transcript.js`, `pricing.js`) are the primary test targets, mirroring the notifier's testable-core split (a pure function + a thin I/O entry point). Include malformed / version-drifted transcript lines in `transcript.js` tests. Do not introduce a different test framework (Jest, Vitest, etc.) without updating the architecture doc.

## Subtree-scoped rules

- **Hooks must never block Claude Code.** Every hook-invoked script (`emit.js`, `ensure.js`, `ensure-deps.js`) wraps its work in try/catch, logs to stderr, and **exits 0** — always. A hook may never throw, hang, or return a non-zero exit that could disturb a session. The daemon is off the hook's critical path: the event log is the source of truth, and the daemon ping is best-effort.
- **Transcript parsing is version-tolerant.** `transcript.js` must never throw into the daemon. Skip unparseable lines, tolerate unknown/missing fields, and degrade to time-only accounting when usage can't be read — because the transcript JSONL format is internal to Claude Code and can change between releases. Keep all such tolerance behind the `transcript.js` interface.
- **Verification (no browser here).** The `node --test` suite plus a stdin smoke test are the verification for this subtree, e.g.:
  > `printf '{"hook_event_name":"Stop","cwd":"%s"}' "$(pwd)" | node scripts/emit.js`

  Confirm the event lands in the log and (if the daemon is up) the state updates. Only then report the change complete.
