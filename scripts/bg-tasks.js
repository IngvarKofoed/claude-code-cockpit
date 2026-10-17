'use strict';

// PURE helpers over Claude Code's background-task surfaces, for the hook (emit.js): which ids
// may be stored, which tool result launched a background task, and which shell is a test run.
// Kept apart from emit.js so they are unit-testable without running the hook, and free of
// dependencies so requiring them costs the hook nothing.

// Claude Code's background task ids are short opaque tokens (`bjtg3c5e2`). Anything else is
// dropped rather than stored, so a future payload change can't smuggle free text into the log.
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_TASK_IDS = 50;

function isTaskId(v) {
  return typeof v === 'string' && TASK_ID_RE.test(v);
}

// The task id a PostToolUse just put in the background, or null. Bash reports it as
// `backgroundTaskId` however the shell got there — run_in_background, Ctrl+B, or Claude
// Code auto-backgrounding a long foreground command — so the tool result is read rather
// than tool_input.run_in_background. A Monitor reports `taskId`; a PERSISTENT one runs for
// the session's life by design, so it is never something the session is waiting to finish.
function bgLaunchId(payload) {
  if (!payload || payload.hook_event_name !== 'PostToolUse') return null;
  const r = payload.tool_response;
  if (!r || typeof r !== 'object') return null;
  if (isTaskId(r.backgroundTaskId)) return r.backgroundTaskId;
  if (payload.tool_name === 'Monitor' && r.persistent !== true && isTaskId(r.taskId)) return r.taskId;
  return null;
}

// Whether a background shell's command is a test run: some bare command WORD contains `e2e`
// or `test` (`npx playwright test`, `npm run e2e`, `vitest`, `dotnet test`, `pytest`). Only
// words count, because the naive substring test was measured matching servers: quoted strings
// are dropped first (grep patterns, SQL, a seeded `'RallyTest!2026'` password), and a token
// holding `/`, `.` or `=` is a path, file name or env assignment — `src/e2e/Flux.E2E.Tests`,
// `E2E_PORT=6100`, a dev server logging to `temp/ivory-test/dev.log`. A watch-mode run never
// exits, so it never counts. The classification happens here, in the hook; only the matching
// task's opaque id is stored, never the command.
function looksLikeTestRun(command) {
  if (typeof command !== 'string' || !command) return false;
  const words = command
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, ' ')
    .split(/[\s;&|()<>`]+/)
    .filter(Boolean);
  // An explicit opt-out (`--watch=false`, `--watchAll=false`, `--no-watch`) is not watch mode.
  if (words.some((w) => /watch/i.test(w) && !/=false$|^--no-watch/i.test(w))) return false;
  // `latest` is a version tag (`npx serve@latest`, `postgres:latest`), never a test word —
  // and it rides on exactly the commands that start long-lived servers.
  return words.some((w) => !/[/.=]/.test(w) && /e2e|test/i.test(w.replace(/latest/gi, '')));
}

module.exports = { TASK_ID_RE, MAX_TASK_IDS, isTaskId, bgLaunchId, looksLikeTestRun };
