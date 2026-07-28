'use strict';

// SessionStart entry: ensure dependencies are installed, then ensure the daemon
// is running and current. Health-checks the daemon; if it's absent or on an old
// version, spawns a fresh one DETACHED so it survives this hook exiting. Never
// blocks on the daemon and always exits 0 — a hook must not disturb a session.
//
// It also runs the one-shot Windows OWNER PROBE (see owner-pid.js). That has to
// happen here, inside a hook, because it walks up from this process's shell to find
// the durable claude.exe — and that shell dies the moment the hook exits, taking the
// only path to the real pid with it. The probe is kicked off FIRST so its PowerShell
// start-up overlaps the dependency check and health request rather than adding to
// them, and it is bounded so SessionStart can never hang on it.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const { ensureDeps } = require('./ensure-deps');
const { appendEvent, pingDaemon } = require('./event-log');
const { resolveOwnerPid } = require('./owner-pid');

const DEFAULT_PORT = 4319;
const HEALTH_TIMEOUT_MS = 300;
// Hard ceiling for the owner probe, enforced across BOTH of its stages (see
// resolveOwnerPid). It measures ~200ms via wmic, so this is generous — but it is on
// SessionStart's critical path, and a wedged WMI service must not turn every session
// start (including resume, /clear and /compact) into a multi-second stall.
const OWNER_PROBE_MS = 1200;
// Backstop so we never hang SessionStart. On Windows it must outlast the owner probe,
// or the backstop would fire first and kill the probe every time.
const EXIT_GUARD_MS = process.platform === 'win32' ? OWNER_PROBE_MS + 800 : 1000;

let exited = false;
function done() {
  if (exited) return;
  exited = true;
  process.exit(0);
}

function logErr(err) {
  try {
    process.stderr.write(`[cockpit ensure] ${(err && err.stack) || err}\n`);
  } catch (_e) {
    // ignore — best-effort logging
  }
}

function pkgVersion() {
  try {
    return require('../package.json').version || null;
  } catch (_e) {
    return null;
  }
}

// Prefer the port the daemon last recorded; fall back to the stable default.
function readPort() {
  try {
    const p = parseInt(fs.readFileSync(paths.portPath(), 'utf8').trim(), 10);
    if (p) return p;
  } catch (_e) {
    // no port file yet
  }
  return DEFAULT_PORT;
}

// Callback receives 'current' (a live daemon on the current version), 'stale' (a
// live daemon on a different/old version that must be replaced), or 'absent'
// (nothing reachable).
function checkHealth(port, version, cb) {
  let settled = false;
  const finish = (status) => {
    if (settled) return;
    settled = true;
    cb(status);
  };
  try {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', timeout: HEALTH_TIMEOUT_MS },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          try {
            const h = JSON.parse(data);
            if (h && h.ok === true) finish(!version || h.version === version ? 'current' : 'stale');
            else finish('absent');
          } catch (_e) {
            finish('absent');
          }
        });
        res.on('error', () => finish('absent'));
      }
    );
    req.on('timeout', () => {
      req.destroy();
      finish('absent');
    });
    req.on('error', () => finish('absent'));
    req.end();
  } catch (_e) {
    finish('absent');
  }
}

function spawnDaemon() {
  try {
    const child = spawn(process.execPath, [path.join(__dirname, 'daemon.js')], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  } catch (err) {
    logErr(err); // singleton lock in the daemon resolves any spawn race
  }
}

// Stop an old-version daemon so its successor can take the singleton lock. The
// old daemon's SIGTERM handler removes the lock/pid/port files as it exits, and
// the new daemon's acquireLock retries until that happens.
function stopOldDaemon() {
  try {
    const pid = parseInt(fs.readFileSync(paths.pidPath(), 'utf8').trim(), 10);
    if (pid) process.kill(pid, 'SIGTERM');
  } catch (_e) {
    // no pid file, or the process is already gone — nothing to stop
  }
}

// Read the hook payload from stdin. A TTY is skipped deliberately: `commands/open.md`
// and `commands/backfill.md` both tell the user to run this script directly, and there
// `readFileSync(0)` would block for an EOF that never comes — with the event loop
// stalled, the EXIT_GUARD backstop can't fire either, so the process would hang until
// Ctrl-C and the daemon would never start. No stdin simply means no probe.
function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

function parsePayload(raw) {
  try {
    // Strip a leading BOM: JSON.parse rejects one outright, which would silently
    // degrade the whole payload to {} — and here that means skipping the probe.
    const obj = JSON.parse(String(raw).replace(/^﻿/, ''));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_e) {
    return {};
  }
}

// Resolve this session's durable host pid and record it as an `OwnerResolved` event,
// so the reaper can treat a dead pid as real evidence the session is gone. Windows
// only (resolveOwnerPid no-ops elsewhere), once per session, and entirely best-effort:
// any failure just leaves the reaper on its generous idle fallback, as before.
function probeOwner(sessionId) {
  if (sessionId == null) return Promise.resolve();
  return resolveOwnerPid(process.ppid, OWNER_PROBE_MS)
    .then((ownerPid) => {
      if (ownerPid == null) return;
      appendEvent({
        ts: new Date().toISOString(),
        event: 'OwnerResolved',
        session_id: sessionId,
        owner_pid: ownerPid,
      });
      return new Promise((resolve) => pingDaemon(resolve));
    })
    .catch(logErr);
}

function main() {
  // Drain stdin before anything else — the probe needs the session id, and the hook
  // payload is only readable here.
  const payload = parsePayload(readStdin());
  const sessionId = typeof payload.session_id === 'string' ? payload.session_id : null;

  // ensureDeps FIRST, even though overlapping it with the probe would save a few ms on
  // the warm path. On a first run it blocks the event loop in `spawnSync('npm install')`
  // for tens of seconds — long enough that a probe started beforehand would come back to
  // an already-expired timeout and resolve as a failure, so the very first session on a
  // new machine would silently never get its durable pid.
  ensureDeps(); // idempotent; a one-time cost on first run only

  const probe = probeOwner(sessionId);
  const version = pkgVersion();
  const daemonReady = new Promise((resolve) => {
    checkHealth(readPort(), version, (status) => {
      if (status === 'stale') stopOldDaemon(); // replace an old-version daemon on upgrade
      // absent or stale: the new daemon's acquireLock retries until any predecessor releases
      if (status !== 'current') spawnDaemon();
      resolve();
    });
  });

  // Exit once BOTH are settled; neither can reject (both swallow their own errors).
  Promise.all([probe, daemonReady]).then(done, done);
  // Backstop in case the health request neither responds, errors, nor times out.
  setTimeout(done, EXIT_GUARD_MS);
}

try {
  main();
} catch (err) {
  logErr(err);
  done();
}
