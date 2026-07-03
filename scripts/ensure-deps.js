'use strict';

// Idempotent dependency installer, run from SessionStart via ensure.js.
// Fast path: if `node-notifier` already resolves, do nothing. Otherwise run a
// one-time `npm install` in the plugin root, guarded by a lockfile so several
// concurrent SessionStarts don't launch npm at once. Never throws.

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const PLUGIN_ROOT = path.join(__dirname, '..');
const LOCK_FILE = path.join(PLUGIN_ROOT, '.deps-install.lock');
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
// A lock is treated as abandoned only well AFTER the longest a real install can
// run (2x the timeout), so a slow-but-still-live install is never judged stale
// and reclaimed — which would start a second `npm install` in the same dir.
const LOCK_STALE_MS = 2 * INSTALL_TIMEOUT_MS;

function logErr(err) {
  try {
    process.stderr.write(`[cockpit ensure-deps] ${(err && err.stack) || err}\n`);
  } catch (_e) {
    // ignore — best-effort logging
  }
}

function depsPresent() {
  try {
    require.resolve('node-notifier', { paths: [PLUGIN_ROOT] });
    return true;
  } catch (_e) {
    return false;
  }
}

function writeLock() {
  const fd = fs.openSync(LOCK_FILE, 'wx'); // exclusive create — fails if held
  try {
    fs.writeSync(fd, String(process.pid));
  } finally {
    fs.closeSync(fd);
  }
}

// Returns true if we now hold the lock; false if another run holds a fresh one.
function acquireLock() {
  try {
    writeLock();
    return true;
  } catch (e) {
    if (!e || e.code !== 'EEXIST') return false;
    // Held — reclaim only if the existing lock is stale (owner likely crashed).
    try {
      const st = fs.statSync(LOCK_FILE);
      if (Date.now() - st.mtimeMs <= LOCK_STALE_MS) return false;
      fs.rmSync(LOCK_FILE, { force: true });
      writeLock();
      return true;
    } catch (_e) {
      return false;
    }
  }
}

function releaseLock() {
  try {
    fs.rmSync(LOCK_FILE, { force: true });
  } catch (_e) {
    // ignore
  }
}

function ensureDeps() {
  try {
    if (depsPresent()) return;
    if (!acquireLock()) return; // another SessionStart is installing — let it
    try {
      if (depsPresent()) return; // may have completed between our two checks
      const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
      spawnSync(npm, ['install', '--no-audit', '--no-fund', '--no-package-lock'], {
        cwd: PLUGIN_ROOT,
        stdio: 'ignore',
        timeout: INSTALL_TIMEOUT_MS,
      });
    } finally {
      releaseLock();
    }
  } catch (err) {
    logErr(err);
  }
}

module.exports = { ensureDeps };

if (require.main === module) ensureDeps();
