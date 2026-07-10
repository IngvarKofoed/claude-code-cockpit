'use strict';

// Blocking PreToolUse gate — a SEPARATE hook from emit.js, deliberately.
//
// emit.js is the non-blocking event logger: it must always exit fast and never
// hold up a tool call (see scripts/CLAUDE.md). This gate does the opposite — it
// can keep its process ALIVE, polling the control file, to freeze a tool call
// while the pause sentinel is set. Folding a blocking loop into emit.js would
// violate its "always exit fast" invariant, so the two live in separate scripts
// wired as two parallel PreToolUse commands: Claude Code runs matching hooks in
// parallel and applies the most-restrictive decision, so the gate can block/deny
// without ever delaying emit.js's event logging.
//
// The control file (pause.pausePath via pause.js) is the sole ruler: no chat
// prompt resumes a pause, only the file (or the dashboard / slash command that
// writes it). The gate reads the file DIRECTLY, so pausing works whether or not
// the daemon is up, and NEVER depends on the daemon.
//
// Fail OPEN (missing / unreadable / empty / unrecognized file → the tool runs)
// and fail SAFE (held to the ceiling → an explicit deny). Every path exits 0 —
// a non-zero exit could disturb a session.

const fs = require('fs');
const pause = require('./pause');

// Re-check the control file this often while paused. A pending timer keeps Node
// alive between checks (no busy-wait, no while-loop).
const POLL_MS = 1500;
// Internal ceiling, just under the hook's 24h timeout so the gate turns a
// would-be silent proceed into an explicit deny before Claude Code kills it.
const MAX_WAIT_MS = 86000 * 1000; // ~23.9h

// The fail-safe deny emitted at the ceiling (verified hookSpecificOutput format).
const DENY_JSON = JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason:
      'Cockpit pause gate held ~24h; set the control file to running (or run /cockpit:resume) to continue.',
  },
});

let exited = false;
function finish() {
  if (exited) return;
  exited = true;
  process.exit(0);
}

function logErr(err) {
  try {
    process.stderr.write(`[cockpit gate] ${(err && err.stack) || err}\n`);
  } catch (_e) {
    // stderr unavailable — nothing more we can do, still exit 0.
  }
}

// Drain stdin defensively so a piped payload never leaves the process waiting on
// an unread fd. The gate is payload-agnostic — it decides purely from the file.
function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

// Emit the fail-safe deny, then exit 0.
function deny() {
  try {
    process.stdout.write(DENY_JSON);
  } catch (_e) {
    // stdout unavailable — the tool proceeds on the killed-hook path; still exit 0.
  }
  finish();
}

function main() {
  readStdin();

  // Step 1: read the control file first. Common case (not paused) exits
  // immediately WITHOUT reading config.
  const content = pause.readPauseState();
  if (!pause.isPaused(content)) return finish();

  // Step 2: paused — only now read the opt-in flag and let the canonical
  // gateDecision rule combine them ('run' here means the feature is off; a stray
  // paused file never freezes a user who hasn't opted in).
  if (pause.gateDecision(content, pause.pauseGateEnabled()) === 'run') return finish();

  // Step 3: paused AND enabled — poll the control file until it flips to running
  // (or the ceiling fires). Watches ONLY the control file: disabling the feature
  // mid-pause does not release an already-blocked call (the file is the ruler).
  const startedAt = Date.now();
  const tick = () => {
    try {
      if (!pause.isPaused(pause.readPauseState())) return finish(); // resumed → tool runs
      if (Date.now() - startedAt >= MAX_WAIT_MS) return deny(); // ceiling → fail safe
      setTimeout(tick, POLL_MS);
    } catch (err) {
      logErr(err);
      finish(); // fail open on any error mid-poll
    }
  };
  setTimeout(tick, POLL_MS);
}

try {
  main();
} catch (err) {
  logErr(err);
  finish();
}
