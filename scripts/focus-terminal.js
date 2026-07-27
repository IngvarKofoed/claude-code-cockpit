'use strict';

// Raise the terminal window hosting a given Claude Code session.
//
// Two platform chains behind one interface. Both start from the session's `ownerPid`
// (captured on every event by emit.js) and end in an opaque focus TARGET string the
// daemon stores per session; the browser only ever posts a sessionId.
//
//   macOS    ownerPid -> `ps -o tty=` -> `/dev/ttysNNN` -> the Terminal tab whose `tty`
//            matches -> select the tab, raise its window, activate the app. Terminal.app
//            only; iTerm2, Ghostty and any multiplexer resolve to no match.
//   Windows  ownerPid -> walk `Win32_Process` parents to the first ancestor that owns a
//            window -> `pid:<n>` -> restore if minimized, then SetForegroundWindow with
//            an AppActivate fallback.
//
// The Windows path is WINDOW-level only: Windows Terminal keeps every tab in one
// `WindowsTerminal.exe` window and exposes no way to select a tab by pid, so a wt.exe
// session raises the right window but lands on whichever tab was last active. A legacy
// conhost window (cmd.exe, a standalone pwsh) is one window per session, so those focus
// exactly. This is the same class of limit as iTerm2/tmux on macOS.
//
// Nothing here ever takes a value from the browser. The daemon passes a pid it already
// holds, and each target is shape-checked before it reaches an OS command: the tty
// travels to osascript through argv, and the Windows pid is integer-validated and then
// interpolated into a fixed PowerShell script which is passed base64 as
// `-EncodedCommand` (no shell, and no command-line quoting to get wrong).

const { execFile } = require('node:child_process');

// macOS terminal device names: ttys000, ttys004, ... Deliberately strict — anything
// that isn't this shape is treated as "no terminal" rather than passed along.
const TTY_NAME = /^tty[a-z]*[0-9]+$/;
const TTY_DEVICE = /^\/dev\/tty[a-z]*[0-9]+$/;
// Windows targets are the window-owning pid. Bounded length so a junk value can't grow
// unboundedly on its way to Number().
const WINDOW_TARGET = /^pid:([0-9]{1,10})$/;

// How far up the parent chain to look for a window owner. Real chains are short
// (WindowsTerminal.exe -> pwsh.exe -> node.exe -> node.exe), so this only bounds a
// pathological or cyclic walk.
const MAX_ANCESTORS = 12;

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

// Walk from `pid` up to the first ancestor owning a window, printing `pid=<n>` or `none`.
//
// Two guards, both about NOT raising the wrong window:
//   - `CreationDate` catches pid reuse — Win32_Process keeps reporting a ParentProcessId
//     after the parent exits, so a recycled pid could otherwise look like a live ancestor.
//   - The stop list ends the walk at the desktop shell and the session-critical processes.
//     Every session's chain eventually reaches explorer.exe, whose "main window" is the
//     desktop/taskbar — so a shell that reports no console window of its own (which happens
//     in a legacy conhost, where the window belongs to a conhost.exe CHILD and can't be
//     reached by walking up) would otherwise resolve to the taskbar. Stopping turns that
//     into an honest "no window", i.e. a hidden button rather than a wrong one.
const WINDOWLESS_ANCESTORS = [
  'explorer.exe',
  'svchost.exe',
  'services.exe',
  'wininit.exe',
  'winlogon.exe',
  'csrss.exe',
  'lsass.exe',
  'smss.exe',
  'dwm.exe',
  'sihost.exe',
  'taskhostw.exe',
];

const windowPidScript = (pid) => `$ErrorActionPreference = 'SilentlyContinue'
$stop = @(${WINDOWLESS_ANCESTORS.map((n) => `'${n}'`).join(',')})
$id = ${pid}
$prev = $null
for ($i = 0; $i -lt ${MAX_ANCESTORS}; $i++) {
  $ci = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $id)
  if (-not $ci) { break }
  if ($prev -and $ci.CreationDate -gt $prev) { break }
  if ($stop -contains $ci.Name) { break }
  $p = Get-Process -Id $id
  if ($p -and $p.MainWindowHandle -ne 0) { Write-Output ('pid=' + $id); exit 0 }
  $prev = $ci.CreationDate
  $id = [int]$ci.ParentProcessId
  if ($id -le 0) { break }
}
Write-Output 'none'`;

// Raise `pid`'s window. SetForegroundWindow can be refused outright when the caller
// isn't the foreground process, so WScript.Shell's AppActivate is the fallback — it goes
// through a different (looser) path and often succeeds where the raw call doesn't.
const focusWindowScript = (pid) => `$ErrorActionPreference = 'SilentlyContinue'
$id = ${pid}
$p = Get-Process -Id $id
if (-not $p -or $p.MainWindowHandle -eq 0) { Write-Output 'notfound'; exit 0 }
$h = $p.MainWindowHandle
Add-Type -Namespace Cockpit -Name Native -MemberDefinition @"
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
"@
if ([Cockpit.Native]::IsIconic($h)) { [void][Cockpit.Native]::ShowWindow($h, 9) }
$ok = [Cockpit.Native]::SetForegroundWindow($h)
if (-not $ok) { try { $ok = (New-Object -ComObject WScript.Shell).AppActivate($id) } catch { $ok = $false } }
if ($ok) { Write-Output 'ok' } else { Write-Output 'failed' }`;

// Run a PowerShell script with no profile and no console flash. The script is passed as
// UTF-16LE base64 (`-EncodedCommand`), which is what PowerShell documents for scripts
// carrying quotes or newlines — it removes command-line quoting from the picture entirely.
// Never rejects: the callers treat any failure as "no window".
function runPowerShell(script, timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 20 },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
}

// Parse `ps -o tty= -p <pid>` output into a /dev path, or null when the process has no
// controlling terminal. ps prints `??` for that case and pads the column with spaces.
function parseTtyDevice(stdout) {
  if (typeof stdout !== 'string') return null;
  const first = stdout.split('\n')[0].trim();
  if (!first || first === '??') return null;
  if (!TTY_NAME.test(first)) return null;
  return '/dev/' + first;
}

// Parse the ancestor walk's output into a pid, or null for `none` / anything unexpected.
function parseWindowPid(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = /^pid=([0-9]{1,10})$/.exec(stdout.split('\n')[0].trim());
  if (!m) return null;
  const pid = Number(m[1]);
  return pid > 0 ? pid : null;
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

// Resolve the pid of the first ancestor owning a window, or null (a service, a session
// under a windowless host). Never rejects, for the same reason as ttyForPid.
function windowPidForPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve(null);
  return runPowerShell(windowPidScript(pid), 10000).then(parseWindowPid);
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

// Bring `pid`'s window to the front. Same contract as focusTty. `focus-refused` is kept
// distinct from `no-window`: the window exists, Windows just declined to raise it.
function focusWindowPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return Promise.resolve({ ok: false, reason: 'invalid-target' });
  }
  if (process.platform !== 'win32') {
    return Promise.resolve({ ok: false, reason: 'unsupported-platform' });
  }
  return runPowerShell(focusWindowScript(pid), 20000).then((stdout) => {
    if (stdout == null) return { ok: false, reason: 'powershell-failed' };
    const out = stdout.trim();
    if (out === 'ok') return { ok: true };
    if (out === 'notfound') return { ok: false, reason: 'no-window' };
    return { ok: false, reason: 'focus-refused' };
  });
}

// Resolve the focus target the daemon stores for a session, or null when this session
// can't be focused (no terminal, no window, or an unsupported platform). The target is
// opaque to the caller — its shape is what routes focusTarget below.
function resolveFocusTarget(pid) {
  if (process.platform === 'darwin') return ttyForPid(pid);
  if (process.platform === 'win32') {
    return windowPidForPid(pid).then((wp) => (wp == null ? null : 'pid:' + wp));
  }
  return Promise.resolve(null);
}

// Focus whatever a stored target names. Routing on the target's SHAPE (not the current
// platform) means a target carried over in a snapshot from another OS can't be handed to
// the wrong OS command — it fails the shape check instead.
function focusTarget(target) {
  if (typeof target === 'string') {
    if (TTY_DEVICE.test(target)) return focusTty(target);
    const m = WINDOW_TARGET.exec(target);
    if (m) return focusWindowPid(Number(m[1]));
  }
  return Promise.resolve({ ok: false, reason: 'invalid-target' });
}

module.exports = {
  parseTtyDevice,
  parseWindowPid,
  ttyForPid,
  windowPidForPid,
  focusTty,
  focusWindowPid,
  resolveFocusTarget,
  focusTarget,
};
