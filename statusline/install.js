#!/usr/bin/env node
'use strict';

// Cross-platform installer for the cockpit statusline.
//
// This is the REAL installer; install.sh / .ps1 / .cmd / .bat are thin wrappers
// that just re-exec `node install.js`. The logic lives here in Node because the
// job is a careful JSON edit of a file full of the user's other settings, and
// because Node is already a hard prerequisite — the statusline itself is a Node
// script, so anyone who can run the statusline can run this.
//
// It points the USER-scope ~/.claude/settings.json `statusLine.command` at this
// directory's statusline-render.js. It writes a timestamped backup before
// touching anything, and is idempotent: if the command already points at this
// renderer it does nothing (so a re-run can't back up an already-correct file).
// Claude Code has a single statusline slot, so a DIFFERENT existing statusLine
// is warned about as it is replaced.
//
// Edits ~/.claude/settings.json (user scope) ONLY — never a project/.claude one.
//
// Two things that look like details but are not:
//
//   - The renderer path is written with FORWARD slashes even on Windows. Claude
//     Code runs statusLine.command through a shell (Git Bash on many Windows
//     setups), and Git Bash silently eats unquoted backslashes — a native
//     C:\Users\... path produces a broken command that fails silently.
//   - The ABSOLUTE path is written, not ${CLAUDE_PLUGIN_ROOT}: that variable is
//     not substituted in statusLine.command (see README.md), so it would expand
//     to an empty string. The cost is that a marketplace install must be re-run
//     after a plugin upgrade moves the install directory.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// A cockpit renderer at some OTHER path (e.g. the repo moved, or a plugin
// upgrade changed the version directory) is an UPDATE, not a foreign statusline
// being clobbered — this substring is how the two are told apart.
const MARKER = 'statusline/statusline-render.js';

const rendererPath = path.join(__dirname, 'statusline-render.js');
// Forward slashes on every platform — see the header note.
const renderer = rendererPath.split(path.sep).join('/');
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
const command = `node "${renderer}"`;

function die(msg) {
  console.error('error: ' + msg);
  process.exit(1);
}

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}` +
    `-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
  );
}

if (!fs.existsSync(rendererPath)) {
  die(`renderer not found at ${rendererPath}`);
}

// Ensure the settings file exists; remember whether it pre-existed so we only
// back up real user content (a freshly-created {} has nothing to preserve).
let preexisted = true;
if (!fs.existsSync(settingsPath)) {
  preexisted = false;
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, '{}\n');
}

// Read and parse. An existing file that does not parse is a HARD STOP rather
// than something to overwrite with a fresh object: this is the user's global
// settings, and silently discarding it over a stray trailing comma is a far
// worse outcome than making them fix one character. (The bash installer this
// replaces did reset it to {}, relying on the backup — deliberately changed.)
let settings = {};
if (preexisted) {
  let raw;
  try {
    raw = fs.readFileSync(settingsPath, 'utf8');
  } catch (e) {
    die(`cannot read ${settingsPath}: ${e.message}`);
  }
  if (raw.trim() === '') {
    settings = {};
  } else {
    try {
      settings = JSON.parse(raw);
    } catch (e) {
      die(
        `${settingsPath} is not valid JSON (${e.message}).\n` +
          '       Fix or remove it and re-run — refusing to overwrite your settings.',
      );
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
      die(`${settingsPath} does not contain a JSON object — refusing to overwrite it.`);
    }
  }
}

const existing =
  settings.statusLine && typeof settings.statusLine === 'object' && !Array.isArray(settings.statusLine)
    ? settings.statusLine
    : {};
const current = typeof existing.command === 'string' ? existing.command : '';

// Windows paths are case-insensitive, and the drive letter's case depends on how
// the installer was invoked (`C:\...` from cmd, `c:/...` from Git Bash). Comparing
// verbatim would make a re-run through a DIFFERENT wrapper look like a change and
// write a pointless backup, so the idempotency check folds case there.
const same = (a, b) =>
  process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;

if (same(current, command)) {
  console.log('Cockpit statusline already installed — nothing to do.');
  console.log(`  statusLine.command = ${command}`);
  process.exit(0);
}

// Compare on forward slashes so a pre-existing backslash path still reads as
// "ours" and reports an update rather than a foreign statusline being replaced.
if (current.replace(/\\/g, '/').toLowerCase().includes(MARKER)) {
  console.log(`Updating cockpit statusline path -> ${renderer}`);
} else if (current === '') {
  console.log('Installing cockpit statusline.');
} else {
  console.error('warning: replacing your existing statusLine.command:');
  console.error(`  ${current}`);
}

let backup = null;
if (preexisted) {
  backup = `${settingsPath}.backup-${timestamp()}`;
  fs.copyFileSync(settingsPath, backup);
  console.log(`Backup written to ${backup}`);
}

// Preserve any other statusLine sub-keys (padding, refreshInterval, …) and
// every other top-level setting.
existing.type = 'command';
existing.command = command;
settings.statusLine = existing;
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');

console.log(`Done. statusLine.command -> ${command}`);
console.log('Restart Claude Code for it to take effect, then open the dashboard');
console.log('(/cockpit:open) to see the live usage bars.');
console.log(
  backup
    ? `Revert by restoring ${backup} (or removing the statusLine key).`
    : `Revert by removing the statusLine key from ${settingsPath}.`,
);
