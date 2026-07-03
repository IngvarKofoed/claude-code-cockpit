'use strict';

// Cross-platform path resolution for claude-code-cockpit.
// Config lives in the OS config dir; all mutable runtime state (event/usage
// logs, rollups, snapshot, port/pid/lock/token files, daemon log) under the
// state dir. Every env var is read lazily inside each function so tests can
// override HOME/XDG/APPDATA at runtime.

const os = require('os');
const path = require('path');
const fs = require('fs');

const APP_NAME = 'claude-code-cockpit';

function configDir() {
  if (process.platform === 'win32') {
    const base = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(base, APP_NAME);
  }
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(base, APP_NAME);
}

function stateDir() {
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, APP_NAME);
  }
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, APP_NAME);
}

function configPath() {
  return path.join(configDir(), 'config.json');
}

function eventsDir() {
  return path.join(stateDir(), 'events');
}

function usageDir() {
  return path.join(stateDir(), 'usage');
}

function rollupsDir() {
  return path.join(stateDir(), 'rollups');
}

function eventLogPath(dateString) {
  return path.join(eventsDir(), `${dateString}.jsonl`);
}

function usageLogPath(dateString) {
  return path.join(usageDir(), `${dateString}.jsonl`);
}

function rollupPath(dateString) {
  return path.join(rollupsDir(), `${dateString}.json`);
}

function snapshotPath() {
  return path.join(stateDir(), 'snapshot.json');
}

function portPath() {
  return path.join(stateDir(), 'cockpit.port');
}

function pidPath() {
  return path.join(stateDir(), 'cockpit.pid');
}

function lockPath() {
  return path.join(stateDir(), 'cockpit.lock');
}

function tokenPath() {
  return path.join(stateDir(), 'cockpit.token');
}

function logPath() {
  return path.join(stateDir(), 'daemon.log');
}

function ensureDirs() {
  // eventsDir/usageDir/rollupsDir all live under stateDir, so creating them
  // creates stateDir too; configDir is separate.
  for (const dir of [configDir(), eventsDir(), usageDir(), rollupsDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// 'YYYY-MM-DD' in LOCAL time — the day boundary the logs rotate on.
function dateStr(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = {
  APP_NAME,
  configDir,
  stateDir,
  configPath,
  eventsDir,
  usageDir,
  rollupsDir,
  eventLogPath,
  usageLogPath,
  rollupPath,
  snapshotPath,
  portPath,
  pidPath,
  lockPath,
  tokenPath,
  logPath,
  ensureDirs,
  dateStr,
};
