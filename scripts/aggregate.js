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
    toolCount: 0, // total tool invocations (incl. subagents), bumped on PreToolUse
    // Cumulative "engaged" wall-clock: time the session spent running a turn OR
    // with a subagent/workflow in flight, EXCLUDING permission/idle waits. Driven
    // by the incremental clock in applyEvent (see engagedSince), not by turn deltas.
    activeMs: 0,
    // Count of background tasks (workflow / subagent / run_in_background shell / …) still in
    // flight, from Claude Code's task registry (Stop / SubagentStop `background_tasks` length,
    // v2.1.145+). The reliable "is this session still working after its turn's Stop" signal;
    // drives isEngaged. 0 when nothing is backgrounded (or on older Claude Code that omits it).
    bgTasks: 0,
    // Set by applyEvent to true on exactly the event that ENDS the engaged period (turn done
    // AND no background work left) — the daemon fires "session finished" on this, so a Stop that
    // only handed off to a background workflow doesn't notify and the real completion does.
    disengagedNow: false,
    engagedSince: null, // ms epoch the current engaged span began, or null when not engaged
    activeDelta: 0, // engaged ms settled by the LAST applyEvent (the daemon reads this per event)
    // ISO ts the current CONTINUOUS engaged period began (set on not-engaged→engaged,
    // cleared when it ends). Surfaced to the card so the big timer keeps counting
    // while a background workflow's subagents run after the launching turn's Stop.
    engagedStartedAt: null,

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

// A session is "engaged" (accruing active time, ticking the card's big timer) while it is
// running a turn OR has background work still in flight. NOT while merely `waiting` (a
// permission prompt) or `idle` with nothing backgrounded. "Background work in flight" comes
// from Claude Code's AUTHORITATIVE task registry (session.bgTasks — the length of the Stop/
// SubagentStop `background_tasks` array, v2.1.145+), NOT the ±unreliable SubagentStart/
// SubagentStop counter. This is what keeps a background workflow / subagent / run_in_background
// shell counting after the launching turn's Stop, while ensuring a dropped SubagentStop can no
// longer strand the session "engaged" forever (the count self-heals on the next carrying event).
function isEngaged(session) {
  return session.status === 'running' || num(session.bgTasks) > 0;
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

  // Pre-event engaged state, captured BEFORE this event's status/bgTasks changes, so the
  // re-anchor below can detect the engaged→idle transition (the true "finished" moment).
  const wasEngaged = isEngaged(session);

  // Absorb Claude Code's authoritative background-task count when this event carries it
  // (Stop / SubagentStop). A present value — INCLUDING 0 — is authoritative; an absent field
  // (older Claude Code, or an event that doesn't carry the registry) leaves the last known
  // count intact. This is what settles bgTasks to 0 at real completion so isEngaged flips off.
  if (typeof event.bg_tasks === 'number') session.bgTasks = event.bg_tasks;

  // --- engaged clock: settle the span that just elapsed under the PRE-event state.
  // engagedSince is non-null IFF the session was engaged since that instant, so its
  // presence alone means the [engagedSince, now] interval counts — no need to
  // re-check isEngaged here. num() guards a session restored from an older snapshot
  // that lacks the field. activeDelta exposes this event's settled ms to the daemon
  // (for per-repo/day rollup attribution) and is recomputed every event.
  const nowMs = tsMs(event.ts);
  session.activeDelta = 0;
  if (session.engagedSince && nowMs > session.engagedSince) {
    const d = nowMs - session.engagedSince;
    session.activeMs = num(session.activeMs) + d;
    session.activeDelta = d;
  }

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
      // num() coercion is required: loadSnapshot restores sessions straight from
      // JSON without running newSession, so a session live across a daemon upgrade
      // has no toolCount key and a bare += 1 would poison it to NaN (same guard the
      // engaged clock uses for activeMs).
      session.toolCount = num(session.toolCount) + 1;
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
        // background work runs and the main loop is quiet, so treat it as a
        // done-signal only when nothing is in flight (no background task per the
        // authoritative bgTasks count, no tool mid-call); that both avoids falsely
        // idling a working session and still settles a `running` session whose Stop
        // was somehow missed, which would otherwise tick a live timer forever.
        const inFlight = num(session.bgTasks) > 0 || session.currentActivity != null;
        if (session.status === 'running' && !inFlight) {
          // Treat this as the missed Stop: CLOSE the turn — clear currentPrompt
          // (else snapshot keeps emitting currentPromptStartedAt and the browser
          // ticks the prompt timer forever, the exact failure this guard prevents).
          // The engaged clock already settled the running span above; going idle
          // stops further accrual.
          session.currentPrompt = null;
          session.status = 'idle';
        }
      }
      // other types (auth_success, …) leave status unchanged
      break;

    case 'Stop':
      session.currentPrompt = null;
      session.currentActivity = null; // the turn's tool is no longer running; don't leave a
      // stale "Running <tool>" showing while the card reads idle (or while background work runs)
      session.status = 'idle';
      break;

    case 'StopFailure':
      // StopFailure ends the turn (like Stop) but on an API error — clear the
      // running prompt so the dashboard stops ticking a live timer on a session
      // whose turn is already over.
      session.currentPrompt = null;
      session.currentActivity = null;
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

  // Settle a stale background-residual `running`. When a background workflow runs after its
  // launching turn's Stop, the subagents' PreToolUse/PostToolUse (on the parent) leave status
  // at 'running' with no open prompt. So the event that empties background_tasks (typically the
  // last SubagentStop) arrives while status is still 'running' — which would keep isEngaged
  // true and never signal completion. If background work is now done (bgTasks===0) and no
  // foreground turn is open (currentPrompt is null — an open turn would legitimately be
  // running), that 'running' is residue: settle to idle so the engaged period actually ends
  // (engagedNow below flips false → disengagedNow true → the daemon fires "finished" here, at
  // real completion). Only touches 'running'; 'waiting'/'error' keep their meaning.
  if (num(session.bgTasks) === 0 && !session.currentPrompt && session.status === 'running') {
    session.status = 'idle';
  }

  // Re-anchor the engaged clock based on the POST-event state.
  const engagedNow = isEngaged(session);
  if (engagedNow) {
    // Advance the anchor to now, but NEVER move it backward on an out-of-order or
    // clock-skewed ts — that would make the next span over-count. A missing/bad ts
    // (nowMs === 0) leaves the existing anchor intact.
    if (nowMs && (!session.engagedSince || nowMs > session.engagedSince)) session.engagedSince = nowMs;
    // Stamp the START of this continuous engaged period once (on the not-engaged→
    // engaged transition, or when restored engaged without the field). It persists
    // as the session stays engaged — including across a Stop while background work
    // keeps running — so the card's timer counts the whole engaged period, not just the turn.
    if (!session.engagedStartedAt && typeof event.ts === 'string') session.engagedStartedAt = event.ts;
  } else {
    // No longer engaged (turn ended / idle): stop the clock. Do this even with a bad
    // ts, so a Stop whose ts is unparseable can't leave a stale anchor that the next
    // event would then settle as one huge idle gap.
    session.engagedSince = null;
    session.engagedStartedAt = null;
  }

  // True exactly on the event that ended the engaged period (a Stop with no background work
  // left, or the SubagentStop that emptied background_tasks) — NOT a Stop that handed off to a
  // still-running background workflow. The daemon fires the "session finished" notification /
  // "done" cue on this, so the notification lands at real completion, not the premature handoff.
  session.disengagedNow = wasEngaged && !engagedNow;

  return state;
}

// --- Snapshot for /api/state -------------------------------------------------

function toCard(s) {
  // One shallow copy (this is on the SSE broadcast hot path), then drop the internal
  // engaged-clock anchors — they're daemon bookkeeping, not UI.
  const card = { ...s, currentPromptStartedAt: s.currentPrompt ? s.currentPrompt.startedAt : null };
  delete card.engagedSince;
  delete card.activeDelta;
  delete card.disengagedNow; // daemon-only transition flag; bgTasks stays for the client's effectiveStatus
  return card;
}

// Waiting first (needs the user), then running, then everything else; ties
// broken by most-recent activity. A session with background work still in flight
// (bgTasks>0) ranks as running — it IS working, and the client colours/ticks it as
// running — so its grid position agrees with its appearance (mirrors effectiveStatus).
function statusRank(card) {
  if (card.status === 'waiting') return 0;
  if (card.status === 'running' || num(card.bgTasks) > 0) return 1;
  return 2;
}

function compareCards(a, b) {
  const ra = statusRank(a);
  const rb = statusRank(b);
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
  // hourActive[0..23]: active ms bucketed by local hour-of-day, populated alongside
  // per-repo active in accumulateActiveFromEvents so the History by-hour chart reads
  // it straight off the (cached) rollup instead of re-scanning the event log.
  return { date: dateStr, repos: {}, hourActive: new Array(24).fill(0) };
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
      byTool: {}, // toolName -> count, tallied from PreToolUse (event-derived, unconditional)
      subagents: 0, // total subagents spawned, tallied from SubagentStart (event-derived)
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

// Fold one completed turn's prompt + tokens into the repo (and per-model) totals.
// Active time is NOT accrued here — it's derived from the event stream (see
// accumulateActiveFromEvents), so a turn's duration no longer feeds activeMs.
// Cost is left untouched — the daemon prices rollups.
function accumulateTurn(rollup, turn) {
  if (!rollup || !turn || turn.repoRoot == null) return rollup;
  const repo = ensureRepo(rollup, turn.repoRoot, turn.repoName);
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
  repo.prompts += 1; // active time comes from the event stream, not turn duration
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

// Derive per-repo (and per-hour) active time from a day's event stream and fold it
// into `rollup`. Replays the events through applyEvent on a FRESH state so the exact
// same engaged clock that drives the live per-session activeMs also produces the
// rollup — the two can't diverge. Each settled span is attributed to the repo and to
// the local hour of the event that closed it.
// A fresh state per day means a span still engaged across midnight is NOT carried
// into the next day (its pre-boundary portion isn't settled here, its post-boundary
// portion starts from the day's first event). The live path mirrors this by breaking
// each session's engaged span at day rollover (and at a stale-day restart), so the
// two agree — the shared, documented cost is that a span crossing midnight loses the
// slice between its last pre-midnight and first post-midnight event.
function accumulateActiveFromEvents(rollup, events) {
  if (!rollup || !Array.isArray(events)) return rollup;
  const s = createState();
  for (const ev of events) {
    applyEvent(s, ev);
    const sid = ev && ev.session_id;
    const sess = sid != null ? s.sessions[sid] : null;
    if (sess && sess.activeDelta > 0 && sess.repoRoot != null) {
      ensureRepo(rollup, sess.repoRoot, sess.repoName).activeMs += sess.activeDelta;
      const t = tsMs(ev.ts);
      if (t && Array.isArray(rollup.hourActive)) rollup.hourActive[new Date(t).getHours()] += sess.activeDelta;
    }
    // Tally per-repo tool usage on its OWN branch, UNCONDITIONALLY — every PreToolUse
    // with a tool_name, independent of the engaged clock. Deliberately NOT gated on
    // activeDelta > 0 like the active fold above: a PreToolUse can legitimately settle
    // activeDelta === 0 (the first event after rolloverDay nulled engagedSince, or a
    // tool starting engagement from idle), so gating byTool on the active fold would
    // drop those calls and make today's figure change on restart vs. this rescan.
    if (ev && ev.event === 'PreToolUse' && ev.tool_name != null && sess && sess.repoRoot != null) {
      const repo = ensureRepo(rollup, sess.repoRoot, sess.repoName);
      repo.byTool[ev.tool_name] = num(repo.byTool[ev.tool_name]) + 1;
    }
    // Per-repo subagent count, same unconditional event-derived pattern as byTool.
    if (ev && ev.event === 'SubagentStart' && sess && sess.repoRoot != null) {
      ensureRepo(rollup, sess.repoRoot, sess.repoName).subagents += 1;
    }
  }
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
  accumulateActiveFromEvents,
};
