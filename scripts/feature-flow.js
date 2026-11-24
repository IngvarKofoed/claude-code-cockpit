'use strict';

// Feature-flow status for the Live card: find the `/feature-flow` skill's state file for a
// live session, by session id, and project it down to a short allowlisted shape.
//
// The skill owns the files and their format; the cockpit only READS them. Two places hold one:
//   <common git dir>/feature-flow-pending/<session id>.json      design steps 1-3, before the
//                                                                 feature's worktree exists
//   <common git dir>/worktrees/<name>/feature-flow-state.json     every step after that
// The common git dir is found from the session's repoRoot `.git` entry, following the same
// `gitdir:` pointer repo.js reads. No subprocess, no fs.watch: the daemon polls.
//
// Privacy: the projection is the only thing that leaves this module, and it is served live
// only — the daemon never stores it (snapshot, event/usage log, rollups) or logs it. It keeps
// a fixed set of fields, clamps every string, and never carries a path (repo, worktree, spec,
// progress log). The progress log is never opened.
//
// Pure-ish, in the shape of repo.js: filesystem reads only, and it never throws — a missing,
// unreadable, oversized or unparseable file is skipped, and anything else odd yields no entry.

const fs = require('fs');
const path = require('path');
const { gitDirFor } = require('./repo');

const STATE_NAME = 'feature-flow-state.json';
const PENDING_DIR = 'feature-flow-pending';
const MIN_VERSION = 2; // the first format carrying step_number / step_total / waiting_for
const PENDING_MAX_AGE_MS = 24 * 3600 * 1000; // a design abandoned before its worktree: hide it
const QUIET_AFTER_MS = 3600 * 1000; // working, but no update for an hour: the session may be gone
const MAX_STR = 160;
const MAX_FILE_BYTES = 64 * 1024; // a state file is ~1KB; refuse to parse anything absurd
// A session id goes into a path only when it is an opaque token (Claude Code's are UUIDs), in
// the manner of bg-tasks.js's TASK_ID_RE — so no id can walk out of the pending folder.
const SID_RE = /^[A-Za-z0-9_-]{1,128}$/;
// The skill composes `step` as "4/10 Building"; the label is what follows the counter. A bare
// counter ("4/10", an empty label) strips to nothing, so the block never repeats the counter.
const STEP_PREFIX_RE = /^\s*\d+\s*\/\s*\d+(?:\s+|$)/;

function isSessionId(v) {
  return typeof v === 'string' && SID_RE.test(v);
}

// One single line of display text, at most MAX_STR characters (code points, so an emoji is
// never split), or null when there is nothing to show. Non-strings are null.
function clampText(v) {
  if (typeof v !== 'string') return null;
  const s = v.replace(/\s+/g, ' ').trim();
  if (!s) return null;
  const chars = Array.from(s);
  return chars.length <= MAX_STR ? s : chars.slice(0, MAX_STR - 1).join('') + '…';
}

function toMs(v) {
  if (typeof v !== 'string') return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

function toCount(v) {
  return Number.isInteger(v) && v >= 0 ? v : null;
}

// The repository's COMMON git dir for a session's repoRoot, or null. A `.git` directory is the
// common dir itself. A `.git` file's `gitdir:` target is a linked worktree's private dir when
// its parent is named `worktrees`, so the common dir is two levels up; any other target (a
// submodule's `.git/modules/<name>`) is taken as its own common dir, which harmlessly finds
// nothing. Never throws.
function commonGitDir(repoRoot) {
  if (typeof repoRoot !== 'string' || !repoRoot) return null;
  try {
    const dotGit = path.join(repoRoot, '.git');
    const gitDir = gitDirFor(dotGit, repoRoot);
    if (!gitDir) return null;
    if (gitDir === dotGit) return dotGit;
    const parent = path.dirname(gitDir);
    return path.basename(parent) === 'worktrees' ? path.dirname(parent) : gitDir;
  } catch (_e) {
    return null;
  }
}

// Parse one state file, or null when it is missing, unreadable, oversized, unparseable, not an
// object, or of a format older than MIN_VERSION. Never throws.
function readStateFile(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_FILE_BYTES) return null;
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    if (typeof raw.version !== 'number' || !(raw.version >= MIN_VERSION)) return null;
    return raw;
  } catch (_e) {
    return null;
  }
}

// The allowlisted projection of a parsed state file — the only shape that leaves the module.
// A field this module doesn't find is null, which drops its line from the card rather than
// hiding the feature.
function project(raw, nowMs) {
  const stepText = clampText(raw.step);
  const stepLabel = stepText ? clampText(stepText.replace(STEP_PREFIX_RE, '')) : null;
  const stepName = clampText(raw.step_name);
  const waitingForUser = raw.waiting_for_user === true;
  const updatedAt = toMs(raw.updated_at);
  return {
    title: clampText(raw.title),
    stepNumber: toCount(raw.step_number),
    stepTotal: toCount(raw.step_total),
    stepLabel,
    // On build steps the skill's step_name IS the label ("4/10 Building" / "Building"), so
    // there is no sub-step to show; on design, feedback and ship it names one ("Research").
    subStep: stepName && stepName !== stepLabel ? stepName : null,
    doing: clampText(raw.doing),
    waitingForUser,
    waitingFor: waitingForUser ? clampText(raw.waiting_for) : null,
    quiet: !waitingForUser && updatedAt != null && nowMs - updatedAt > QUIET_AFTER_MS,
    startedAt: toMs(raw.started_at),
    updatedAt,
  };
}

// Every worktree state file under a common git dir, parsed once per tick and shared by every
// session of that repository: [{ sid, raw }].
function scanWorktrees(common) {
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(path.join(common, 'worktrees'));
  } catch (_e) {
    return out;
  }
  for (const name of names) {
    const raw = readStateFile(path.join(common, 'worktrees', name, STATE_NAME));
    if (raw && isSessionId(raw.session_id)) out.push({ sid: raw.session_id, raw });
  }
  return out;
}

// This session's pending design file, or null. Its session_id must match the file's own key,
// and one whose updated_at is over a day old is a design abandoned before it got a worktree.
// A missing updated_at can't be aged, so it is kept (and loses any tie).
function readPending(common, sid, nowMs) {
  const raw = readStateFile(path.join(common, PENDING_DIR, `${sid}.json`));
  if (!raw || raw.session_id !== sid) return null;
  const updated = toMs(raw.updated_at);
  if (updated != null && nowMs - updated > PENDING_MAX_AGE_MS) return null;
  return raw;
}

// Newest updated_at wins; a file with none loses to any file that has one. An exact tie keeps
// the earlier candidate.
function newest(cands) {
  let best = null;
  let bestT = -Infinity;
  for (const raw of cands) {
    const t = toMs(raw.updated_at);
    const key = t == null ? -Infinity : t;
    if (best === null || key > bestT) {
      best = raw;
      bestT = key;
    }
  }
  return best;
}

// One poll: sessions is an iterable of { sessionId, repoRoot } (the live ones). Returns a Map
// sessionId -> projection, holding only the sessions that have a feature flow. Each common git
// dir is resolved and its worktrees scanned once per call, however many sessions share it.
// A session whose id isn't an opaque token is skipped without touching the filesystem.
// Never throws.
function lookupFlows(sessions, nowMs = Date.now()) {
  const out = new Map();
  try {
    const commonByRoot = new Map();
    const worktreesByCommon = new Map();
    for (const s of sessions || []) {
      try {
        const sid = s && s.sessionId;
        if (!isSessionId(sid)) continue;
        let common = commonByRoot.get(s.repoRoot);
        if (common === undefined) {
          common = commonGitDir(s.repoRoot);
          commonByRoot.set(s.repoRoot, common);
        }
        if (!common) continue;
        let worktrees = worktreesByCommon.get(common);
        if (!worktrees) {
          worktrees = scanWorktrees(common);
          worktreesByCommon.set(common, worktrees);
        }
        // Worktree files first, so an exact tie goes to the feature a worktree has adopted.
        const cands = [];
        for (const w of worktrees) if (w.sid === sid) cands.push(w.raw);
        const pending = readPending(common, sid, nowMs);
        if (pending) cands.push(pending);
        const best = newest(cands);
        if (best) out.set(sid, project(best, nowMs));
      } catch (_e) {
        /* one odd session never costs the others theirs */
      }
    }
  } catch (_e) {
    /* never throws into the daemon */
  }
  return out;
}

module.exports = {
  lookupFlows,
  commonGitDir,
  readStateFile,
  project,
  clampText,
  isSessionId,
  STATE_NAME,
  PENDING_DIR,
  MIN_VERSION,
  PENDING_MAX_AGE_MS,
  QUIET_AFTER_MS,
  MAX_STR,
};
