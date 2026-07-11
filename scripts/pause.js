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

// Defensive LIGHT read of config.json for the one opt-in flag. Deliberately
// does NOT call config.readConfig() — that can trigger a one-time migration
// WRITE, and a hook must have no side effects. No merge, no migration, no
// default-filling: just parse and read the single field. Returns true only if
// pauseGateEnabled is boolean true or the string 'true'; false on ANY error.
function pauseGateEnabled() {
  try {
    const raw = JSON.parse(fs.readFileSync(paths.configPath(), 'utf8'));
    return raw.pauseGateEnabled === true || raw.pauseGateEnabled === 'true';
  } catch (_e) {
    return false;
  }
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

// PURE: the usage auto-pilot's rising-edge (pause) / hysteresis (resume) rule.
//  - threshold not a finite number > 0 → 'none' (auto-pilot off).
//  - prevPct / curPct null/NaN are treated as 0.
//  - RISING EDGE: prev below and cur at/above the threshold, and the file is NOT a paused
//    sentinel (running/'') → 'pause' (never clobber a manual pause).
//  - RESUME (hysteresis): file is exactly 'paused-usage' and cur has fallen below the resume
//    line — threshold minus the deadband — → 'resume'. Deliberately NOT the instant cur dips
//    back under the threshold: that shared-line rule flapped on a rolling-window wobble. The
//    deadband is capped at half the threshold so a low threshold keeps a resume line above 0
//    (it never strands paused-forever), and a real reset or lower-usage subscription still
//    clears it.
//  - otherwise → 'none'.
function autoPauseDecision({ prevPct, curPct, threshold, sentinel } = {}) {
  if (!(typeof threshold === 'number' && Number.isFinite(threshold) && threshold > 0)) {
    return 'none';
  }
  const prev = typeof prevPct === 'number' && Number.isFinite(prevPct) ? prevPct : 0;
  const cur = typeof curPct === 'number' && Number.isFinite(curPct) ? curPct : 0;
  const s = String(sentinel == null ? '' : sentinel).trim();
  const resumeAt = threshold - Math.min(AUTO_RESUME_DEADBAND_PCT, threshold / 2);

  if (prev < threshold && cur >= threshold && !PAUSE_SENTINELS.has(s)) return 'pause';
  if (s === 'paused-usage' && cur < resumeAt) return 'resume';
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
