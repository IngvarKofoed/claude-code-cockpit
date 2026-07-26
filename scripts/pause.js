'use strict';

// Pause-gate core for claude-code-cockpit — the small, PURE decision helpers
// plus the minimal file I/O shared by the blocking gate hook (gate.js), the
// daemon's pause reconciler, the statusline renderer, and the slash commands.
//
// The control file (paths.pausePath()) is the sole enforcement source of truth:
// its content is a bare sentinel — `running` (or absent/empty) to run, `paused`
// (manual) or `paused-usage` (auto) to freeze. The two paused sentinels differ
// only so the daemon can auto-resume its own `paused-usage` without ever lifting
// a manual `paused`; the gate treats both identically.
//
// Everything here is fail-open and never throws: a missing / unreadable / empty
// / unrecognized control file always resolves to "run".

const fs = require('fs');
const path = require('path');
const paths = require('./paths');

// The bare tokens written to the control file.
const RUNNING = 'running';
// Any sentinel in this set freezes tool execution; anything else runs.
const PAUSE_SENTINELS = new Set(['paused', 'paused-usage']);

// True iff the trimmed content is exactly one of the paused sentinels. Exact
// set-match (NOT startsWith) so any unrecognized / empty / garbage content is
// treated as "not paused" — this is the whole fail-open rule in one predicate.
function isPaused(content) {
  return PAUSE_SENTINELS.has(String(content == null ? '' : content).trim());
}

// Map a control-file sentinel to the pause reason recorded in the event log:
// 'paused' → 'manual', 'paused-usage' → 'usage', anything else → null.
function sentinelReason(content) {
  const s = String(content == null ? '' : content).trim();
  if (s === 'paused') return 'manual';
  if (s === 'paused-usage') return 'usage';
  return null;
}

// PURE: 'wait' iff the feature is enabled AND the control file holds a paused
// sentinel; otherwise 'run'. `enabled` must be strictly true (a stray control
// file never freezes a user who hasn't opted in).
function gateDecision(controlContent, enabled) {
  return enabled === true && isPaused(controlContent) ? 'wait' : 'run';
}

// Read + trim the control file. Returns '' on any error (never throws) — the
// caller treats '' as "run" via isPaused/gateDecision.
function readPauseState() {
  try {
    return fs.readFileSync(paths.pausePath(), 'utf8').trim();
  } catch (_e) {
    return '';
  }
}

// Atomically write the bare sentinel token to the control file (mkdir parent,
// tmp write + same-dir rename), mirroring config.js atomicWriteConfigFile.
// `sentinel` is one of RUNNING / 'paused' / 'paused-usage'.
function writePauseState(sentinel) {
  const file = paths.pausePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, String(sentinel));
  fs.renameSync(tmp, file);
}

// Defensive LIGHT read of config.json for the one gate flag. Deliberately does
// NOT call config.readConfig() — that can trigger a one-time migration WRITE, and
// a hook must have no side effects (it only reads DEFAULT_CONFIG). Resolution:
//   • EXPLICIT setting wins: true/'true' → on, false/'false' → off (a persisted
//     opt-out is never overridden by the on-by-default).
//   • Parsed config that OMITS the key (or isn't an object) → shipped default,
//     so the on-by-default gate is armed and this read agrees with the daemon's
//     merged config for a fresh / config-less / minimal install.
//   • NO config file (ENOENT) → shipped default too — the fresh-install case.
//   • Any OTHER read error, or an UNPARSEABLE file → FAIL OPEN (false). A blocking
//     hook must never freeze every session on a config it couldn't read/parse;
//     here the gate's fail-open rule outranks matching the daemon (which would
//     default such a config to on). Never throws.
// config.js is required LAZILY (matching gate.js's http/path pattern): the common
// not-paused hook path never calls this, so it must not pay to load + freeze it.
function pauseGateEnabled() {
  const { DEFAULT_CONFIG } = require('./config');
  const dflt = DEFAULT_CONFIG.pauseGateEnabled === true;
  let text;
  try {
    text = fs.readFileSync(paths.configPath(), 'utf8');
  } catch (e) {
    return e && e.code === 'ENOENT' ? dflt : false;
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (_e) {
    return false; // file exists but is corrupt/partial → fail open
  }
  const v = raw && typeof raw === 'object' ? raw.pauseGateEnabled : undefined;
  if (v === true || v === 'true') return true;
  if (v === false || v === 'false') return false;
  return dflt;
}

// Epoch ms for an ISO string; unparseable sorts LAST (Infinity) so a bad
// timestamp never reorders good records ahead of it.
function pauseTsMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : Infinity;
}

// A fresh span accumulator: pausedMs (closed spans) + one open span (openTs/
// openReason, null when running). This is the mutable state foldPauseEvent folds
// into; both foldPauseState (whole-log) and the daemon's live reconciler use it,
// so the open/close span math has exactly ONE implementation.
function newPauseAcc() {
  return { pausedMs: 0, openTs: null, openReason: null };
}

// PURE: fold ONE { ts, event:'Paused'|'Resumed', reason? } record into an
// accumulator (from newPauseAcc), mutating and returning it. Opens a span on
// Paused only if none is open (a double Paused keeps the first); closes it on
// Resumed, adding the delta to pausedMs (a stray Resumed / negative delta is
// ignored). The single source of the span-fold rule; never throws.
function foldPauseEvent(acc, ev) {
  if (!acc || !ev || typeof ev !== 'object') return acc;
  if (ev.event === 'Paused') {
    if (acc.openTs === null) {
      acc.openTs = ev.ts;
      acc.openReason = ev.reason || null;
    }
  } else if (ev.event === 'Resumed') {
    if (acc.openTs !== null) {
      const delta = pauseTsMs(ev.ts) - pauseTsMs(acc.openTs);
      if (Number.isFinite(delta) && delta > 0) acc.pausedMs += delta;
      acc.openTs = null;
      acc.openReason = null;
    }
  }
  return acc;
}

// Derive the public { paused, pausedSince, pausedMs, reason } shape from an
// accumulator. pausedMs is CLOSED spans only — the client adds the live open
// slice (now − pausedSince).
function pauseStateOf(acc) {
  const pausedMs = (acc && acc.pausedMs) || 0;
  if (acc && acc.openTs != null) {
    return { paused: true, pausedSince: acc.openTs, pausedMs, reason: acc.openReason || null };
  }
  return { paused: false, pausedSince: null, pausedMs, reason: null };
}

// PURE: fold a list of { ts, event:'Paused'|'Resumed', reason? } records into
// { paused, pausedSince, pausedMs, reason } by sorting on ts and replaying each
// record through foldPauseEvent. Tolerant of unbalanced (double Paused / stray
// Resumed) and out-of-order records; never throws.
function foldPauseState(events) {
  const list = Array.isArray(events) ? events.slice() : [];
  list.sort((a, b) => pauseTsMs(a && a.ts) - pauseTsMs(b && b.ts));
  const acc = newPauseAcc();
  for (const ev of list) foldPauseEvent(acc, ev);
  return pauseStateOf(acc);
}

// The hysteresis deadband (percentage points) between the auto-pause threshold and the
// auto-RESUME line: the auto-pilot pauses AT the threshold but only resumes once usage has
// fallen this far BELOW it. Sharing one line for pause and resume made a rolling 5h % — which
// wobbles a point or two across the boundary as old requests age out and new ones enter —
// flap the gate pause/resume every few seconds. The escape valve for a wrong/stale high push
// (e.g. a lagging cross-subscription reading) is preserved but bounded by the resume line: a
// corrected reading BELOW it — a real window reset (→~0%) or a switch to a materially
// lower-usage subscription — resumes; a corrected reading that lands back INSIDE the band
// [threshold−deadband, threshold) holds paused. That hold is the deliberate cost of not
// flapping: you stay frozen only while the CURRENT reading is genuinely near the limit, not
// because of a past spike alone (manual Resume always overrides). Fixed (not yet a config
// field) to keep the config surface small.
const AUTO_RESUME_DEADBAND_PCT = 10;

// One window's auto-RESUME line: its pause threshold minus the deadband, the deadband capped at
// half the threshold so a low threshold keeps a resume line above 0 (never strands paused-forever).
function autoResumeLine(threshold) {
  return threshold - Math.min(AUTO_RESUME_DEADBAND_PCT, threshold / 2);
}

// null / NaN / non-numeric reads as 0 — an absent percentage must never look like a crossing.
function pctOrZero(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// PURE: the usage auto-pilot's rising-edge (pause) / hysteresis (resume) rule, over ONE OR MORE
// rate-limit windows (5h and weekly today). Takes either `windows: [{prevPct,curPct,threshold,
// wasOver}]` or the flat single-window `{prevPct,curPct,threshold}` shorthand; `sentinel` is the
// control file.
//  - A window whose threshold isn't a finite number > 0 is DISARMED and dropped; no armed window
//    left → 'none' (auto-pilot off). A window the caller omits (no reading) simply isn't armed, so
//    a missing weekly number can neither pause nor block a resume.
//  - prevPct / curPct null/NaN are treated as 0.
//  - RISING EDGE (ANY armed window): prev below and cur at/above that window's threshold, and the
//    file is NOT a paused sentinel (running/'') → 'pause'. Any one window hitting its limit is
//    reason enough to freeze, and it never clobbers a manual pause.
//  - RESUME: file is exactly 'paused-usage', NO armed window is still at/above its own threshold,
//    and every window that WENT OVER during this pause span (`wasOver`, tracked by the caller) has
//    fallen below its own resume line. Two rules in one because they answer different questions:
//    the threshold check stops a resume that would undo a limit still being exceeded, while the
//    deadband is purely anti-flap and therefore applies ONLY to a window that actually tripped —
//    a rolling % wobbling across its own line is what flapped the gate. Applying the deadband to
//    an innocent window instead strands the gate: a weekly sitting quietly at 85 (threshold 90,
//    resume line 80) would hold every 5h auto-pause open long after 5h reset to 0.
//    `wasOver` DEFAULTS TO TRUE when omitted — the conservative reading, so a caller that doesn't
//    track spans keeps the plain hysteresis behaviour.
//  - otherwise → 'none'.
function autoPauseDecision({ windows, prevPct, curPct, threshold, sentinel } = {}) {
  const armed = (Array.isArray(windows) ? windows : [{ prevPct, curPct, threshold }])
    .filter((w) => w && typeof w.threshold === 'number' && Number.isFinite(w.threshold) && w.threshold > 0)
    .map((w) => ({
      prev: pctOrZero(w.prevPct),
      cur: pctOrZero(w.curPct),
      threshold: w.threshold,
      wasOver: w.wasOver !== false,
    }));
  if (armed.length === 0) return 'none';
  const s = String(sentinel == null ? '' : sentinel).trim();

  if (!PAUSE_SENTINELS.has(s) && armed.some((w) => w.prev < w.threshold && w.cur >= w.threshold)) {
    return 'pause';
  }
  if (
    s === 'paused-usage' &&
    armed.every((w) => w.cur < w.threshold) &&
    armed.every((w) => !w.wasOver || w.cur < autoResumeLine(w.threshold))
  ) {
    return 'resume';
  }
  return 'none';
}

module.exports = {
  RUNNING,
  PAUSE_SENTINELS,
  isPaused,
  sentinelReason,
  gateDecision,
  readPauseState,
  writePauseState,
  pauseGateEnabled,
  newPauseAcc,
  foldPauseEvent,
  pauseStateOf,
  foldPauseState,
  autoPauseDecision,
  AUTO_RESUME_DEADBAND_PCT,
};
