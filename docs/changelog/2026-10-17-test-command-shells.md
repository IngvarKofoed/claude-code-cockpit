# Background test-run shells count as work by their command

A background shell whose command reads as a test run (a command word containing `e2e` or `test`)
now keeps its session running for as long as it runs, however the turn ended. This extends
`2026-10-17-background-shell-wait`. The hook classifies the command and stores only the task's id.

## Detail

- **User's rule, narrowed after measuring it.** The request was "contains e2e or test". Over three
  weeks of real launches, a plain substring test matched 218 of 749 background shells, about 45
  of them long-lived **servers**. Flux "release-shaped unit" boots carry `E2E_PORT=6100` and
  `src/e2e/Flux.E2E.Tests`, one Vite server logs to `temp/ivory-test/dev.log`, and dev-server
  commands seed a `'RallyTest!2026'` password. Each would read Running for an hour after Claude
  finished. So `bg-tasks.looksLikeTestRun` drops quoted strings, skips tokens holding `/`, `.`
  or `=`, and ignores watch mode. It then matches 138 launches: `vitest`, `npx playwright test`,
  `npm run e2e`, `dotnet test`, `pytest`. **Do not loosen it back to a substring test.**
- **`latest` is not a test word** (`npx serve@latest`, `postgres:latest` start servers), and an
  explicit watch opt-out (`--watchAll=false`, `--watch=false`, `--no-watch`) is a one-shot run.
- **Known false positive:** a WebSocket-holder script named `roomtest`. Anything similar is bounded
  by the existing 60-minute cap, which test-run shells share, measured from first sighting.
- **Known misses:** wait loops whose only test word is quoted (`until grep -q "Tests "`), and
  scratchpad scripts (`node $S/pass.js`). Those still count when the turn ends on them.
- **Monitors were not given special handling.** Only 1 of 52 Monitor commands matches once paths
  are skipped, because their `e2e` lives in the log path.
- **Privacy:** the command is read in the hook and never stored. `bg_test_ids` holds opaque ids,
  validated and capped like `bg_shell_ids`. The helpers moved into the pure `bg-tasks.js` so they
  are unit-tested. The cases in `bg-tasks.test.js` are the real server commands above.
- **Verified:** 449 `node --test` passes, smoke-tested emit.js against an isolated state dir, and
  the old and new aggregate still replay 17 real days to identical rollups (no old event carries
  the field). **Not verified:** a real session through the installed plugin, which needs a
  version bump to reach live sessions.
