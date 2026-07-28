'use strict';

// Resolve the DURABLE Claude Code process pid behind a hook invocation.
//
// Only meaningful on Windows. There, Claude Code spawns a FRESH powershell.exe for
// every hook (claude.exe -> powershell.exe -> node emit.js), so a hook's own
// `process.ppid` is a throwaway that dies microseconds after the hook exits —
// measured at ~136 distinct values across 146 events of ONE live session. That made
// the daemon's stale-session reaper read every Windows session as dead. On
// macOS/Linux the hook's parent already outlives the hook, so nothing here is needed.
//
// The walk MUST run while the hook's shell is still alive, which is why this is
// called from inside the SessionStart hook (`ensure.js`) rather than from the daemon:
// once the hook exits, the chain it would have been walked from is gone and the real
// pid is unrecoverable. That puts it on SessionStart's critical path, so cost matters.
//
// Hence the two paths. `wmic` gets the whole process table in ~200ms while blocking
// the event loop for under 10ms, and the walk itself then runs in plain (unit-tested)
// JavaScript here. PowerShell needs ~1.1s for the same answer — measured, and almost
// all of it inside a single `Get-CimInstance` start-up — so it is the FALLBACK, for
// the newer Windows 11 builds where wmic is no longer installed by default.

const { execFile } = require('node:child_process');
const winproc = require('./winproc');

// The image name of the Claude Code host process. A session started through some
// other launcher simply finds no match and degrades to the old behaviour.
//
// KNOWN GAP, deliberately not closed: an npm/global install runs through
// `claude.cmd -> node.exe`, so there is no claude.exe to find and those sessions keep
// the conservative ~6h idle reaper. Adding 'node.exe' to this set would cover them but
// risks the opposite failure — verifying some unrelated node.exe as the session's host,
// which then dies on its own schedule and gets a LIVE session reaped. A wrong verified
// pid is worse than none, since "none" is exactly the pre-probe behaviour. Closing this
// properly needs the ancestor's command line to confirm it is really Claude.
const CLAUDE_IMAGE_NAMES = ['claude.exe'];

const DEFAULT_TIMEOUT_MS = 3000;

// Below this there is no point starting the PowerShell fallback — its start-up alone
// costs more, so it would only burn the remaining budget and still time out.
const MIN_FALLBACK_MS = 600;

// Fixed column order requested from wmic; Name sits between them and is the only
// field that could itself contain a comma, so rows are parsed from both ends inward.
const WMIC_ARGS = [
  'process',
  'get',
  'ProcessId,ParentProcessId,Name,CreationDate',
  '/format:csv',
];

const STOP_NAMES = new Set(winproc.WINDOWLESS_ANCESTORS.map((n) => n.toLowerCase()));

// Parse `wmic ... /format:csv` output into { pid, ppid, name, created } records.
// Header is `Node,CreationDate,Name,ParentProcessId,ProcessId`. Anything malformed is
// skipped rather than thrown on — a wmic that prints a warning banner, or a row for a
// process we can't read, must not take down a hook.
function parseWmicProcesses(stdout) {
  if (typeof stdout !== 'string') return [];
  const out = [];
  for (const raw of stdout.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('Node,')) continue;
    const f = line.split(',');
    if (f.length < 5) continue;
    // From the ends: [0]=Node, [1]=CreationDate, [last-1]=ParentProcessId, [last]=ProcessId.
    const pid = Number(f[f.length - 1]);
    const ppid = Number(f[f.length - 2]);
    if (!Number.isInteger(pid) || pid <= 0) continue;
    if (!Number.isInteger(ppid) || ppid < 0) continue;
    out.push({
      pid,
      ppid,
      name: f.slice(2, f.length - 2).join(',').trim(),
      created: f[1].trim(), // `20260727170524.072000+120`; compared lexically, see below
    });
  }
  return out;
}

// Walk from `startPid` up to the first ancestor named in `matchNames`, or null.
//
// Two guards, both about not trusting a stale chain:
//   - CreationDate catches pid REUSE. Win32_Process keeps reporting a ParentProcessId
//     after the parent exits, so a recycled pid could otherwise pass as a live
//     ancestor. A real parent is always created before its child, so a later-created
//     "parent" ends the walk. Compared as strings, which is valid because every row in
//     one snapshot uses the same fixed-width format and timezone offset; a missing
//     value on either side just skips the check.
//   - The stop list ends the walk at the desktop shell and the session-critical
//     processes, which are never a session's host.
function walkToOwner(procs, startPid, matchNames) {
  if (!Array.isArray(procs) || !Number.isInteger(startPid) || startPid <= 0) return null;
  const want = new Set((matchNames || CLAUDE_IMAGE_NAMES).map((n) => n.toLowerCase()));
  const byPid = new Map();
  for (const p of procs) if (!byPid.has(p.pid)) byPid.set(p.pid, p);

  let id = startPid;
  let prevCreated = null;
  for (let i = 0; i < winproc.MAX_ANCESTORS; i++) {
    const p = byPid.get(id);
    if (!p) return null;
    const name = (p.name || '').toLowerCase();
    if (prevCreated && p.created && p.created > prevCreated) return null; // recycled pid
    if (STOP_NAMES.has(name)) return null;
    if (want.has(name)) return p.pid;
    prevCreated = p.created || prevCreated;
    if (!Number.isInteger(p.ppid) || p.ppid <= 0) return null;
    id = p.ppid;
  }
  return null;
}

// Snapshot the process table via wmic. Resolves null when wmic is absent (newer
// Windows 11) or errored, which sends the caller to the PowerShell fallback.
function wmicProcesses(timeoutMs) {
  return new Promise((resolve) => {
    execFile(
      'wmic',
      WMIC_ARGS,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1 << 24, encoding: 'utf8' },
      (err, stdout) => {
        if (err) return resolve(null);
        const procs = parseWmicProcesses(stdout);
        resolve(procs.length ? procs : null);
      },
    );
  });
}

// Resolve the nearest `claude.exe` ancestor of `startPid`, or null. Never rejects:
// every failure (wrong platform, dead pid, no wmic AND no PowerShell, no match) is
// just "couldn't tell", which leaves the reaper on its generous idle fallback exactly
// as before.
function resolveOwnerPid(startPid, timeoutMs) {
  if (process.platform !== 'win32') return Promise.resolve(null);
  if (!Number.isInteger(startPid) || startPid <= 0) return Promise.resolve(null);
  // ONE budget spanning both stages, not one per stage. The caller sits on SessionStart's
  // critical path with its own exit guard, so a slow wmic followed by a full-budget
  // PowerShell fallback would blow straight through that guard — stalling the hook AND
  // still recording nothing, the worst of both.
  const budget = timeoutMs || DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + budget;
  return wmicProcesses(budget)
    .then((procs) => {
      if (procs) return walkToOwner(procs, startPid, CLAUDE_IMAGE_NAMES);
      // wmic unavailable (newer Windows 11) — fall back to the slower PowerShell walk,
      // but only within whatever time is left.
      const left = deadline - Date.now();
      if (left < MIN_FALLBACK_MS) return null;
      const script = winproc.ancestorWalkScript(startPid, { matchNames: CLAUDE_IMAGE_NAMES });
      return winproc.runPowerShell(script, left).then(winproc.parsePidOutput);
    })
    .catch(() => null);
}

module.exports = {
  CLAUDE_IMAGE_NAMES,
  DEFAULT_TIMEOUT_MS,
  parseWmicProcesses,
  walkToOwner,
  resolveOwnerPid,
};
