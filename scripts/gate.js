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
const paths = require('./paths');
const pause = require('./pause');

// `http` and `path` are required LAZILY inside the marker helpers below — only reached on the
// rare paused-and-emitting branch. This hook runs fresh on EVERY tool call under
// pauseGateEnabled and exits immediately in the common not-paused case, so it shouldn't pay to
// load them on that hot path.

// Best-effort daemon ping budget for the Gated marker (mirrors emit.js). The
// durable append already happened by then; the gate never awaits this.
const PING_TIMEOUT_MS = 150;

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

// Parse the stdin payload for session_id ONLY (the gate is otherwise
// payload-agnostic). Wrapped so a garbage/empty payload never affects the gate.
function parseSessionId(raw) {
  try {
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_e) {
    return {};
  }
}

// Append one object as a single JSON line to today's event log (copied from
// emit.js — a single small-line append is atomic on local filesystems).
function appendEvent(record) {
  const path = require('path'); // lazy — only the paused-and-emitting branch reaches here
  const filePath = paths.eventLogPath(paths.dateStr());
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(record) + '\n');
}

// Best-effort daemon nudge — carries no authoritative data; the daemon always
// re-reads the log. Fire-and-forget: the gate never awaits or blocks on it.
function pingDaemon() {
  try {
    const http = require('http'); // lazy — only the paused-and-emitting branch reaches here
    const readTrim = (p) => {
      try {
        return fs.readFileSync(p, 'utf8').trim();
      } catch (_e) {
        return '';
      }
    };
    const port = parseInt(readTrim(paths.portPath()), 10);
    if (!port) return;
    const token = readTrim(paths.tokenPath());
    const body = '{}';
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/internal/event', method: 'POST', timeout: PING_TIMEOUT_MS, headers },
      (res) => {
        res.resume(); // drain so the socket can close
      }
    );
    req.on('timeout', () => req.destroy());
    req.on('error', () => {});
    req.write(body);
    req.end();
  } catch (_e) {
    // best-effort — a ping failure is invisible to the gate.
  }
}

// Emit ONE Gated marker as the gate enters the poll loop. Fully wrapped: any
// failure is logged and swallowed and can NEVER change the gate decision or the
// exit-0 guarantee. Skips the marker (but the gate still blocks) if session_id
// is missing. PRIVACY: never copies tool_input / message / user_input.
function emitGatedMarker(payload) {
  try {
    const sessionId = payload && payload.session_id;
    if (typeof sessionId !== 'string' || !sessionId) return;
    const record = {
      ts: new Date().toISOString(),
      event: 'Gated',
      session_id: sessionId,
      owner_pid: process.ppid,
    };
    if (typeof payload.tool_name === 'string') record.tool_name = payload.tool_name;
    appendEvent(record);
    pingDaemon();
  } catch (err) {
    logErr(err);
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
  const payload = parseSessionId(readStdin());

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
  // The gate has decided to WAIT (paused AND enabled) and is about to enter the
  // poll loop — emit the one Gated park marker now. Wrapped internally; it can
  // never affect the decision, the poll timing, or the exit-0 guarantee.
  emitGatedMarker(payload);

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
