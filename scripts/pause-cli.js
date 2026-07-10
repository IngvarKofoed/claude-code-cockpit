'use strict';

// Cross-platform CLI behind /cockpit:pause and /cockpit:resume.
//
//   node pause-cli.js pause    -> writes the 'paused' sentinel
//   node pause-cli.js resume   -> writes the 'running' sentinel
//
// Writing the control file is the essential act — the sole ruler — and takes effect whether or
// not the daemon is up (the gate reads the file directly). It then best-effort nudges the daemon
// over localhost so the dashboard reflects the change instantly, reusing emit.js's ping
// discipline (port/token read, short timeout, hard exit guard). The nudge uses node's http —
// NOT curl — so it behaves identically on macOS/Linux/Windows (the whole plugin is curl-free).
// Both commands share this one file so the write+nudge logic lives in a single place.

const http = require('http');
const fs = require('fs');
const paths = require('./paths');
const pause = require('./pause');

const PING_TIMEOUT_MS = 150;
const EXIT_GUARD_MS = 400; // backstop so a stalled daemon socket can't keep the process alive

let exited = false;
function finish(code) {
  if (exited) return;
  exited = true;
  process.exit(code || 0);
}

function readTrim(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_e) {
    return '';
  }
}

// Best-effort POST /internal/event (a wake nudge; body ignored) so the daemon reconciles the
// control file immediately. Swallows every error and always calls done().
function nudgeDaemon(done) {
  let called = false;
  const complete = () => {
    if (called) return;
    called = true;
    done();
  };
  try {
    const port = parseInt(readTrim(paths.portPath()), 10);
    if (!port) return complete();
    const token = readTrim(paths.tokenPath());
    const body = '{}';
    const headers = { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/internal/event', method: 'POST', timeout: PING_TIMEOUT_MS, headers },
      (res) => {
        res.resume();
        res.on('end', complete);
        res.on('error', complete);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      complete();
    });
    req.on('error', complete);
    req.write(body);
    req.end();
  } catch (_e) {
    complete();
  }
}

function main() {
  const arg = (process.argv[2] || '').toLowerCase();
  const sentinel = arg === 'pause' ? 'paused' : arg === 'resume' ? pause.RUNNING : null;
  if (!sentinel) {
    process.stderr.write('usage: node pause-cli.js <pause|resume>\n');
    return finish(1);
  }
  try {
    pause.writePauseState(sentinel); // the essential, daemon-independent act
  } catch (e) {
    process.stderr.write(`[cockpit pause-cli] write failed: ${(e && e.stack) || e}\n`);
    return finish(1);
  }
  process.stdout.write(
    arg === 'pause'
      ? "Paused — every session's next tool call will block within ~2s (only /cockpit:resume, the dashboard Resume button, or editing the control file resumes it).\n"
      : 'Resumed — tool execution continues within ~2s.\n'
  );
  nudgeDaemon(() => finish(0)); // best-effort; the write above already did the real work
  setTimeout(() => finish(0), EXIT_GUARD_MS);
}

try {
  main();
} catch (e) {
  try {
    process.stderr.write(`[cockpit pause-cli] ${(e && e.stack) || e}\n`);
  } catch (_e) {
    /* stderr unavailable */
  }
  finish(1);
}
