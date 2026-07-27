'use strict';

// Raise the macOS Terminal window hosting a given Claude Code session.
//
// The chain is: a session's `ownerPid` (captured on every event by emit.js) -> that
// process's controlling terminal via `ps` -> the Terminal tab whose `tty` matches ->
// select the tab, raise its window, activate the app. Terminal.app is the only
// emulator handled; anything else (iTerm2, Ghostty, tmux, a headless launchd agent)
// simply fails to resolve and the caller reports that.
//
// Nothing here ever takes a value from the browser. The daemon passes a pid it already
// holds, and the resulting tty reaches osascript through argv — never a shell.

const { execFile } = require('node:child_process');

// macOS terminal device names: ttys000, ttys004, ... Deliberately strict — anything
// that isn't this shape is treated as "no terminal" rather than passed along.
const TTY_NAME = /^tty[a-z]*[0-9]+$/;
const TTY_DEVICE = /^\/dev\/tty[a-z]*[0-9]+$/;

// The AppleScript is a single `on run argv` handler so the tty arrives as an argument
// rather than interpolated into the source. `tty of tab` reports the full /dev path.
const FOCUS_SCRIPT = `on run argv
  set target to item 1 of argv
  tell application "Terminal"
    repeat with w in windows
      repeat with t in tabs of w
        try
          if (tty of t as text) is target then
            set selected tab of w to t
            set frontmost of w to true
            activate
            return "ok"
          end if
        end try
      end repeat
    end repeat
  end tell
  return "notfound"
end run`;

// Parse `ps -o tty= -p <pid>` output into a /dev path, or null when the process has no
// controlling terminal. ps prints `??` for that case and pads the column with spaces.
function parseTtyDevice(stdout) {
  if (typeof stdout !== 'string') return null;
  const first = stdout.split('\n')[0].trim();
  if (!first || first === '??') return null;
  if (!TTY_NAME.test(first)) return null;
  return '/dev/' + first;
}

// Resolve a pid's controlling terminal. Never rejects — an unknown pid, a dead process,
// or a missing `ps` are all just "no terminal", which the caller renders as not-focusable.
function ttyForPid(pid) {
  return new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve(null);
    execFile('ps', ['-o', 'tty=', '-p', String(pid)], (err, stdout) => {
      if (err) return resolve(null);
      resolve(parseTtyDevice(stdout));
    });
  });
}

// Bring the Terminal window owning `device` to the front. Resolves
// { ok } or { ok:false, reason } — never rejects.
function focusTty(device) {
  return new Promise((resolve) => {
    if (typeof device !== 'string' || !TTY_DEVICE.test(device)) {
      return resolve({ ok: false, reason: 'invalid-tty' });
    }
    if (process.platform !== 'darwin') {
      return resolve({ ok: false, reason: 'unsupported-platform' });
    }
    execFile('osascript', ['-e', FOCUS_SCRIPT, device], (err, stdout) => {
      if (err) return resolve({ ok: false, reason: 'osascript-failed' });
      if (String(stdout).trim() === 'ok') return resolve({ ok: true });
      resolve({ ok: false, reason: 'no-window' });
    });
  });
}

module.exports = { parseTtyDevice, ttyForPid, focusTty };
