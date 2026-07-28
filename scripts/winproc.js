'use strict';

// Shared Windows process helpers: a hardened PowerShell runner plus the
// `Win32_Process` ancestor walk that both the terminal-focus chain
// (`focus-terminal.js`) and the durable owner-pid probe (`owner-pid.js`) need.
//
// Nothing here ever interpolates a caller-supplied string into a script. The only
// value that reaches PowerShell is an integer-validated pid; the image names come
// from the fixed lists below.

const { execFile } = require('node:child_process');

// How far up the parent chain to look. Real chains are short
// (WindowsTerminal.exe -> pwsh.exe -> node.exe), so this only bounds a
// pathological or cyclic walk.
const MAX_ANCESTORS = 12;

// The walk must stop before the desktop shell. Every chain reaches explorer.exe
// eventually and its "main window" is the taskbar, so a shell that owns no window
// of its own would otherwise resolve to it — a wrong window rather than an honest
// "none". The rest are session-critical processes that are never a session's host.
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

function psList(names) {
  return names.map((n) => `'${n}'`).join(',');
}

// Build a bounded parent-chain walk that prints `pid=<n>` for the first matching
// ancestor, or `none`.
//
//   matchNames: report the first ancestor whose image name is in this list.
//               When null, report the first ancestor that OWNS A WINDOW instead.
//
// `CreationDate` guards pid REUSE: Win32_Process keeps reporting a ParentProcessId
// after the parent exits, so a recycled pid could otherwise pass as a live
// ancestor. A real parent is always created before its child, so a "parent"
// created later than the child it supposedly spawned is a reused pid — end the walk.
function ancestorWalkScript(pid, opts) {
  const o = opts || {};
  const matchNames = o.matchNames || null;
  const stopNames = o.stopNames || WINDOWLESS_ANCESTORS;
  const maxDepth = o.maxDepth || MAX_ANCESTORS;
  if (!Number.isInteger(pid) || pid <= 0) throw new TypeError('pid must be a positive integer');
  const test = matchNames
    ? `if ($match -contains $ci.Name) { Write-Output ('pid=' + $id); exit 0 }`
    : `$p = Get-Process -Id $id
  if ($p -and $p.MainWindowHandle -ne 0) { Write-Output ('pid=' + $id); exit 0 }`;
  return `$ErrorActionPreference = 'SilentlyContinue'
$stop = @(${psList(stopNames)})
$match = @(${psList(matchNames || [])})
$id = ${pid}
$prev = $null
for ($i = 0; $i -lt ${maxDepth}; $i++) {
  $ci = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $id)
  if (-not $ci) { break }
  if ($prev -and $ci.CreationDate -gt $prev) { break }
  if ($stop -contains $ci.Name) { break }
  ${test}
  $prev = $ci.CreationDate
  $id = [int]$ci.ParentProcessId
  if ($id -le 0) { break }
}
Write-Output 'none'`;
}

// Parse a walk's output into a pid, or null for `none` / anything unexpected.
function parsePidOutput(stdout) {
  if (typeof stdout !== 'string') return null;
  const m = /^pid=([0-9]{1,10})$/.exec(stdout.split('\n')[0].trim());
  if (!m) return null;
  const pid = Number(m[1]);
  return pid > 0 ? pid : null;
}

// Run a PowerShell script with no profile and no console flash. The script is
// passed as UTF-16LE base64 (`-EncodedCommand`), which is what PowerShell
// documents for scripts carrying quotes or newlines — it removes command-line
// quoting from the picture entirely. Never rejects: callers treat null as
// "couldn't tell", which every one of them degrades to an honest absence.
//
// `vars` are added to the child's environment. That is the ONLY channel for a value
// the script must compare against but that we refuse to interpolate — free text such
// as a session title, where interpolation would mean building a script out of it.
function runPowerShell(script, timeoutMs, vars) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        Buffer.from(script, 'utf16le').toString('base64'),
      ],
      {
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: 1 << 20,
        encoding: 'utf8',
        env: vars ? { ...process.env, ...vars } : process.env,
      },
      (err, stdout) => resolve(err ? null : String(stdout)),
    );
  });
}

module.exports = {
  MAX_ANCESTORS,
  WINDOWLESS_ANCESTORS,
  ancestorWalkScript,
  parsePidOutput,
  runPowerShell,
};
