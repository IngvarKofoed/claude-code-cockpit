'use strict';

// SessionStart entry: ensure dependencies are installed, then ensure the daemon
// is running and current. Health-checks the daemon; if it's absent or on an old
// version, spawns a fresh one DETACHED so it survives this hook exiting. Never
// blocks on the daemon and always exits 0 — a hook must not disturb a session.

const fs = require('fs');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const paths = require('./paths');
const { ensureDeps } = require('./ensure-deps');

const DEFAULT_PORT = 4319;
const HEALTH_TIMEOUT_MS = 300;
const EXIT_GUARD_MS = 1000; // backstop so we never hang SessionStart

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

function main() {
  ensureDeps(); // idempotent; a one-time cost on first run only
  const version = pkgVersion();
  checkHealth(readPort(), version, (status) => {
    if (status === 'current') return done();
    if (status === 'stale') stopOldDaemon(); // replace an old-version daemon on upgrade
    spawnDaemon(); // the new daemon's acquireLock retries until any predecessor releases
    done();
  });
  // Backstop in case the health request neither responds, errors, nor times out.
  setTimeout(done, EXIT_GUARD_MS);
}

try {
  main();
} catch (err) {
  logErr(err);
  done();
}
