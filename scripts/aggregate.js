'use strict';

// Pure reducer over normalized event records (see CONTRACTS §0/§5): folds the
// event stream into per-session live state, produces the /api/state snapshot,
// and accumulates per-day per-repo rollups. No I/O, no throwing on bad input —
// the daemon owns persistence and token/cost enrichment; this is the core the
// daemon and its unit tests share.

// Coerce anything non-finite (undefined, null, NaN, strings) to 0 so bad input
// can never throw or poison a sum.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

// Epoch ms for an ISO string, or 0 when absent/unparseable — used only for
// ordering, so a bad timestamp sorts last rather than throwing.
function tsMs(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

// --- Session state machine ---------------------------------------------------

function createState() {
  return { sessions: {} };
}

function newSession(event) {
  return {
    sessionId: event.session_id,
    cwd: null,
    repoRoot: null,
    repoName: null,
    branch: null,
    model: null,
    source: null,
    ownerPid: null,
    permissionMode: null,
    effortLevel: null,
    status: 'idle',
    startedAt: typeof event.ts === 'string' ? event.ts : null,
    lastActivityAt: typeof event.ts === 'string' ? event.ts : null,
    currentPrompt: null, // { promptId, startedAt } while a turn is running
    currentActivity: null, // tool name Claude is running right now
    promptCount: 0,
    activeMs: 0, // cumulative wall-clock of this session's closed turns

    subagents: { active: 0, total: 0, byType: {} },
    errorReason: null,
    endedReason: null,
    tokens: null, // daemon fills from transcript.js; null = unavailable
    cost: null, // daemon fills from pricing.js
  };
}

// Opportunistically refresh the stable metadata a session carries whenever an
// event supplies it (repo/model can first appear on later events, effort/mode
// can change mid-session). `branch` may legitimately be null, so it is only
// skipped when the key is entirely absent.
function updateMeta(session, event) {
  if (event.cwd != null) session.cwd = event.cwd;
  if (event.repo_root != null) session.repoRoot = event.repo_root;
  if (event.repo_name != null) session.repoName = event.repo_name;
  if (event.branch !== undefined) session.branch = event.branch;
  if (event.model != null) session.model = event.model;
  if (event.permission_mode != null) session.permissionMode = event.permission_mode;
  if (event.effort_level != null) session.effortLevel = event.effort_level;
  // owner_pid rides on EVERY event (emit.js sets process.ppid), so capture it
  // here — not only on SessionStart — so a session first seen via a later event
  // (e.g. after a snapshot loss) still carries a PID the reaper can check.
  if (event.owner_pid != null) session.ownerPid = event.owner_pid;
  if (event.source != null) session.source = event.source;
}

// Add the just-closed turn's wall-clock duration to the session's cumulative
// active time, using the same prompt-start→stop delta the daemon's recordTurn
// attributes to the per-repo rollup. The two can still diverge: the rollup only
// counts turns that produced fresh transcript usage, whereas this counts every
// closed turn — so per-session active time can slightly exceed the repo's.
function addTurnDuration(session, event) {
  if (!session.currentPrompt || !session.currentPrompt.startedAt) return;
  const a = tsMs(session.currentPrompt.startedAt);
  const b = tsMs(event.ts);
  // num() the prior value: a session restored from a pre-activeMs snapshot has no
  // activeMs field, and `undefined + delta` would poison it to NaN forever.
  if (a && b && b > a) session.activeMs = num(session.activeMs) + (b - a);
}

// Fold one event into state, mutating and returning the same object. Unknown
// events and missing fields are tolerated; an event without a session_id can't
// be attributed and is ignored.
function applyEvent(state, event) {
  if (!state || !state.sessions) return state;
  if (!event || typeof event !== 'object') return state;
  const sid = event.session_id;
  if (sid == null) return state;

  let session = state.sessions[sid];
  if (!session) session = state.sessions[sid] = newSession(event);

  if (typeof event.ts === 'string') session.lastActivityAt = event.ts;
  updateMeta(session, event);

  switch (event.event) {
    case 'SessionStart':
      // ownerPid/source are captured in updateMeta (above), which runs first.
      session.status = 'idle';
      if (typeof event.ts === 'string') session.startedAt = event.ts;
      break;

    case 'UserPromptSubmit': {
      session.status = 'running';
      // prompt_id is absent before the first prompt / on some payloads; synth a
      // stable per-session id so turns stay distinguishable.
      const promptId =
        event.prompt_id != null ? event.prompt_id : `__prompt_${session.promptCount + 1}`;
      session.currentPrompt = { promptId, startedAt: event.ts || null };
      session.promptCount += 1;
      break;
    }

    case 'PreToolUse':
      session.status = 'running';
      if (event.tool_name != null) session.currentActivity = event.tool_name;
      break;

    case 'PostToolUse':
    case 'PostToolUseFailure':
      // A tool just finished (or failed) mid-turn — Claude is working again, so
      // clear the activity and restore 'running'. Without the status reset a
      // permission Notification's 'waiting' would wrongly persist after approval.
      session.currentActivity = null;
      session.status = 'running';
      break;

    case 'Notification':
      // Only a permission prompt genuinely blocks on the user.
      if (event.notification_type === 'permission_prompt') {
        session.status = 'waiting';
      } else if (event.notification_type === 'idle_prompt') {
        // `idle_prompt` = "Claude is done, awaiting your next prompt". On a
        // normal turn the session is already `idle` (its Stop cleared it), so
        // this is a no-op — we deliberately do NOT raise a distinct
        // "awaiting input" state that reads as needs-attention on a turn that
        // is simply done. But Claude Code also emits idle_prompt mid-turn while
        // a subagent works and the main loop is quiet, so treat it as a
        // done-signal only when nothing is in flight (no active subagent, no
        // tool mid-call); that both avoids falsely idling a working session and
        // still settles a `running` session whose Stop was somehow missed,
        // which would otherwise tick a live timer forever.
        const inFlight = session.subagents.active > 0 || session.currentActivity != null;
        if (session.status === 'running' && !inFlight) {
          // Treat this as the missed Stop: actually CLOSE the turn — clear
          // currentPrompt (else snapshot keeps emitting currentPromptStartedAt and
          // the browser ticks the prompt timer forever, the exact failure this
          // guard exists to prevent) and record its duration.
          addTurnDuration(session, event);
          session.currentPrompt = null;
          session.status = 'idle';
        }
      }
      // other types (auth_success, …) leave status unchanged
      break;

    case 'Stop':
      addTurnDuration(session, event);
      session.currentPrompt = null;
      session.status = 'idle';
      break;

    case 'StopFailure':
      // StopFailure ends the turn (like Stop) but on an API error — clear the
      // running prompt so the dashboard stops ticking a live timer on a session
      // whose turn is already over.
      addTurnDuration(session, event);
      session.currentPrompt = null;
      session.status = 'error';
      if (event.stop_reason != null) session.errorReason = event.stop_reason;
      break;

    case 'SubagentStart':
      session.subagents.active += 1;
      session.subagents.total += 1;
      if (event.agent_type != null) {
        session.subagents.byType[event.agent_type] =
          (session.subagents.byType[event.agent_type] || 0) + 1;
      }
      break;

    case 'SubagentStop':
      session.subagents.active = Math.max(0, session.subagents.active - 1);
      break;

    case 'SessionEnd':
      session.status = 'ended';
      if (event.reason != null) session.endedReason = event.reason;
      break;

    default:
      // unknown event: metadata already refreshed above; ignore safely
      break;
  }

  return state;
}

// --- Snapshot for /api/state -------------------------------------------------

function toCard(s) {
  return {
    ...s,
    // ISO the browser uses to tick the live prompt timer, or null when idle.
    currentPromptStartedAt: s.currentPrompt ? s.currentPrompt.startedAt : null,
  };
}

// Waiting first (needs the user), then running, then everything else; ties
// broken by most-recent activity.
function statusRank(status) {
  if (status === 'waiting') return 0;
  if (status === 'running') return 1;
  return 2;
}

function compareCards(a, b) {
  const ra = statusRank(a.status);
  const rb = statusRank(b.status);
  if (ra !== rb) return ra - rb;
  return tsMs(b.lastActivityAt) - tsMs(a.lastActivityAt);
}

// Active-session snapshot. `ended` sessions are dropped from the live list.
function snapshot(state, nowMs) {
  const map = (state && state.sessions) || {};
  const sessions = [];
  for (const sid of Object.keys(map)) {
    const s = map[sid];
    if (s.status === 'ended') continue;
    sessions.push(toCard(s));
  }
  sessions.sort(compareCards);
  return { now: nowMs, sessions };
}

// --- Per-day per-repo rollups ------------------------------------------------

function createRollup(dateStr) {
  return { date: dateStr, repos: {} };
}

function ensureRepo(rollup, repoRoot, repoName) {
  let repo = rollup.repos[repoRoot];
  if (!repo) {
    repo = rollup.repos[repoRoot] = {
      repoName: repoName != null ? repoName : null,
      activeMs: 0,
      prompts: 0,
      sessions: [], // distinct session ids
      tokens: emptyTokens(),
      byModel: {},
      cost: null, // priced by the daemon, not here
      lastActive: null,
    };
  } else if (repoName != null) {
    repo.repoName = repoName; // keep the latest known name
  }
  return repo;
}

function bumpLastActive(repo, ts) {
  if (typeof ts !== 'string') return;
  if (repo.lastActive == null || tsMs(ts) > tsMs(repo.lastActive)) repo.lastActive = ts;
}

function addTokens(dst, tokens) {
  dst.input += num(tokens && tokens.input);
  dst.output += num(tokens && tokens.output);
  dst.cacheRead += num(tokens && tokens.cacheRead);
  dst.cacheWrite += num(tokens && tokens.cacheWrite);
}

// Fold one completed turn's duration + tokens into the repo (and per-model)
// totals. Cost is intentionally left untouched — the daemon prices rollups.
function accumulateTurn(rollup, turn) {
  if (!rollup || !turn || turn.repoRoot == null) return rollup;
  const repo = ensureRepo(rollup, turn.repoRoot, turn.repoName);
  repo.activeMs += num(turn.durationMs);
  repo.prompts += 1;
  addTokens(repo.tokens, turn.tokens);
  const model = turn.model || 'unknown';
  const bucket = repo.byModel[model] || (repo.byModel[model] = emptyTokens());
  addTokens(bucket, turn.tokens);
  bumpLastActive(repo, turn.ts);
  return rollup;
}

// Fold a per-model token map into a repo's totals and per-model buckets. Shared by
// the turn and backfill accumulators so token attribution stays identical on both
// paths (a change here — a new token field, an 'unknown' rule — applies to both).
function addByModel(repo, byModel) {
  const bm = byModel && typeof byModel === 'object' ? byModel : {};
  for (const model of Object.keys(bm)) {
    const key = model || 'unknown';
    addTokens(repo.tokens, bm[model]);
    const bucket = repo.byModel[key] || (repo.byModel[key] = emptyTokens());
    addTokens(bucket, bm[model]);
  }
}

// Like accumulateTurn but attributes a turn's tokens PER MODEL — one turn can span
// models (e.g. a compaction/summary message in a cheaper model, or a mid-session
// model switch). Counts the turn once (prompts += 1) while filing each model's
// tokens under its own byModel bucket, so cost is priced at each model's own rate
// rather than lumping the whole turn onto one model.
function accumulateTurnByModel(rollup, turn) {
  if (!rollup || !turn || turn.repoRoot == null) return rollup;
  const repo = ensureRepo(rollup, turn.repoRoot, turn.repoName);
  repo.activeMs += num(turn.durationMs);
  repo.prompts += 1;
  addByModel(repo, turn.byModel);
  bumpLastActive(repo, turn.ts);
  return rollup;
}

// Add a turn's per-model tokens to a rollup WITHOUT counting it as a turn (no
// prompts++, no activeMs). Used for historical BACKFILL from a transcript: the
// tokens belong to a past day, but that day's turn boundaries/durations aren't
// known when back-reading, so only per-day token/cost totals are attributed.
function accumulateTokensByModel(rollup, turn) {
  if (!rollup || !turn || turn.repoRoot == null) return rollup;
  const repo = ensureRepo(rollup, turn.repoRoot, turn.repoName);
  addByModel(repo, turn.byModel);
  bumpLastActive(repo, turn.ts);
  return rollup;
}

// Register a session against a repo (distinct set) and refresh last-active.
function accumulateSession(rollup, s) {
  if (!rollup || !s || s.repoRoot == null) return rollup;
  const repo = ensureRepo(rollup, s.repoRoot, s.repoName);
  if (s.sessionId != null && !repo.sessions.includes(s.sessionId)) repo.sessions.push(s.sessionId);
  bumpLastActive(repo, s.ts);
  return rollup;
}

module.exports = {
  createState,
  applyEvent,
  snapshot,
  createRollup,
  accumulateTurn,
  accumulateTurnByModel,
  accumulateTokensByModel,
  accumulateSession,
};
