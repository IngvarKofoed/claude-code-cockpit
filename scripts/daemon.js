'use strict';

// The always-on cockpit daemon (CONTRACTS §10). It is the singleton that ties
// every pure module together: it holds a singleton OS lock, replays and tails
// the hook-written event log into live per-session state (aggregate.js), ingests
// token usage from transcripts (transcript.js) at each turn's Stop, persists
// per-turn usage records and per-day rollups, prices them (pricing.js), fires OS
// notifications (notify.js), and serves the buildless dashboard + JSON/SSE API
// over 127.0.0.1. It is spawned/revived by ensure.js on SessionStart.
//
// The event log is the durable source of truth; everything here is derived and
// idempotent by the log's byte offsets and the transcript's message ids, so an
// ungraceful crash never double-counts. On boot the daemon re-seeds the set of
// already-counted message ids from the usage log and back-fills token usage for
// any turns whose Stop fired while it was down.

const fs = require('fs');
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const paths = require('./paths');
const config = require('./config');
const aggregate = require('./aggregate');
const transcript = require('./transcript');
const pricing = require('./pricing');
const notify = require('./notify');
const repoLib = require('./repo');

const VERSION = require('../package.json').version;
const PLUGIN_PATH = process.env.CLAUDE_PLUGIN_ROOT || path.join(__dirname, '..');
const WEB_DIR = path.join(__dirname, '..', 'web');

// Loop cadences (ms).
const TAIL_MS = 500;
const TOKEN_POLL_MS = 5000;
const LONGRUN_MS = 5000;
const REAPER_MS = 10000;
const HEARTBEAT_MS = 15000;
const SNAPSHOT_MS = 5000;
const IDLE_CHECK_MS = 60000;
const SSE_COALESCE_MS = 250; // ≤ ~4 state pushes / second
const REAP_IDLE_FALLBACK_MS = 6 * 3600 * 1000; // reap PID-less sessions after 6h idle
const REAP_GRACE_MS = 90 * 1000; // min quiet time before reaping a PID-dead session

const STATIC = {
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/charts.js': ['charts.js', 'text/javascript; charset=utf-8'],
  '/styles.css': ['styles.css', 'text/css; charset=utf-8'],
};

// ---- daemon state -----------------------------------------------------------

let cfg = config.readConfig();
let TOKEN = '';
let server = null;
let PORT = cfg.port;
let ephemeral = false; // true once we fall back off the stable default port
const startedAtMs = Date.now();

const state = aggregate.createState(); // live per-session state
let currentDate = paths.dateStr();
let todayRollup = aggregate.createRollup(currentDate);
const offsets = {}; // dateStr -> processed byte offset in that day's event log
const seenIds = new Map(); // session_id -> Set(transcript message id) already ingested
const extra = new Map(); // session_id -> { transcriptPath, longRunPromptId }
const ingesting = new Set(); // session_ids with an in-flight ingestTurn retry chain
const pendingIngest = new Map(); // session_id -> { stopEvent } queued mid-ingest
const primedSeen = new Set(); // session_ids whose seenIds have been seeded from the usage logs
const rollupCache = new Map(); // dateStr -> memoized derived past-day rollup (fast History reads)
let repoTotalsCache = null; // memoized all-time per-repo totals for /api/state; invalidated on any token/rollup/cost-config change (see repoTotalsAllTime)

let replaying = false; // true while replaying the log on boot: suppress side effects

const sseClients = new Set();
let sseId = 0;
let dirty = false;
let lastFlush = 0;
let flushTimer = null;
let lastBusyAt = Date.now(); // for idle shutdown

// ---- small helpers ----------------------------------------------------------

function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addTokens(dst, t) {
  dst.input += num(t && t.input);
  dst.output += num(t && t.output);
  dst.cacheRead += num(t && t.cacheRead);
  dst.cacheWrite += num(t && t.cacheWrite);
}

// Local calendar day ('YYYY-MM-DD') for an ISO timestamp, or null if unparseable.
function dayOf(ts) {
  const t = Date.parse(ts);
  if (!Number.isFinite(t)) return null;
  return paths.dateStr(new Date(t));
}

function log(msg) {
  try {
    fs.appendFileSync(paths.logPath(), `${new Date().toISOString()} ${msg}\n`);
  } catch (_e) {
    /* logging must never throw */
  }
}

function readJsonl(p) {
  let content;
  try {
    content = fs.readFileSync(p, 'utf8');
  } catch (_e) {
    return [];
  }
  const out = [];
  for (const line of content.split('\n')) {
    const t = line.trim();
    if (!t) continue;
    try {
      out.push(JSON.parse(t));
    } catch (_e) {
      /* skip malformed / torn line */
    }
  }
  return out;
}

// ---- singleton lock ---------------------------------------------------------

function isAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM'; // exists but not signalable == alive
  }
}

// Block the boot thread for ms (only used while contending for the lock).
function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch (_e) {
    /* SharedArrayBuffer unavailable — skip the wait */
  }
}

// Acquire the exclusive singleton lock, or return false if a live daemon keeps
// holding it. A stale lock (owner dead) is reclaimed. If the lock is held by a
// live process we retry briefly: on a version upgrade ensure.js SIGTERMs the old
// daemon, which releases the lock as it exits, so the replacement acquires it on
// a later attempt. We only ever acquire once the holder actually releases/exits,
// so a healthy singleton is never stolen — a genuine loser just gives up.
function acquireLock() {
  const lp = paths.lockPath();
  const MAX_ATTEMPTS = 8;
  const RETRY_MS = 200;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    try {
      const fd = fs.openSync(lp, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let owner = 0;
      try {
        owner = parseInt(fs.readFileSync(lp, 'utf8').trim(), 10);
      } catch (_e) {
        owner = 0;
      }
      if (!isAlive(owner)) {
        try {
          fs.unlinkSync(lp); // stale — reclaim and retry immediately
        } catch (_e) {
          /* someone else may have just removed it */
        }
        continue;
      }
      sleepSync(RETRY_MS); // held by a live process — give a shutting-down predecessor time
    }
  }
  return false;
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const p of [paths.lockPath(), paths.pidPath(), paths.portPath()]) {
    try {
      fs.unlinkSync(p);
    } catch (_e) {
      /* best effort */
    }
  }
}

function registerCleanup() {
  process.on('exit', cleanup);
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      cleanup();
      process.exit(0);
    });
  }
}

// ---- bearer token -----------------------------------------------------------

function ensureToken() {
  const tp = paths.tokenPath();
  try {
    const existing = fs.readFileSync(tp, 'utf8').trim();
    if (existing) return existing;
  } catch (_e) {
    /* no token yet */
  }
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(tp, t, { mode: 0o600 });
  try {
    fs.chmodSync(tp, 0o600); // enforce 0600 even if the file pre-existed
  } catch (_e) {
    /* best effort on platforms without POSIX perms */
  }
  return t;
}

// ---- state rebuild ----------------------------------------------------------

function loadSnapshot() {
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(paths.snapshotPath(), 'utf8'));
  } catch (_e) {
    return; // no/invalid snapshot -> cold start, fully rebuilt from logs
  }
  if (!snap || typeof snap !== 'object') return;
  if (snap.sessions && typeof snap.sessions === 'object') {
    state.sessions = snap.sessions;
    // A snapshot saved on a different day carries engaged-clock anchors from that
    // day. Today's rollup is re-derived fresh (no carried anchor), so a restored
    // anchor would settle a giant [yesterday, first-event-today] span into the live
    // per-session activeMs that the rollup never sees — a large divergence. Drop the
    // anchors so the live clock re-establishes them from today's events, matching the
    // rollover-reset behavior. (Same-day restart keeps them: the day is replayed
    // continuously, so the anchor is still valid.)
    const staleDay = snap.currentDate !== currentDate;
    for (const sid of Object.keys(state.sessions)) {
      const s = state.sessions[sid];
      if (!s) continue;
      if (s.status === 'idle-waiting') s.status = 'idle'; // migrate a retired status
      if (staleDay) s.engagedSince = null;
    }
  }
  if (snap.extra && typeof snap.extra === 'object') {
    for (const sid of Object.keys(snap.extra)) extra.set(sid, snap.extra[sid]);
  }
  // Restore the counted-message-id sets so ingestion stays idempotent across a
  // restart independently of usage-log pruning — a session whose early usage logs
  // were manually cleaned up (POST /api/data/cleanup) would otherwise have its old
  // transcript messages look "new" to catchUpIngest and be double-counted.
  if (snap.seenIds && typeof snap.seenIds === 'object') {
    for (const sid of Object.keys(snap.seenIds)) {
      const arr = snap.seenIds[sid];
      if (Array.isArray(arr)) seenIds.set(sid, new Set(arr));
    }
  }
  // Trust saved offsets only for the same day; a new day is replayed from 0.
  if (snap.currentDate === currentDate && snap.offsets && typeof snap.offsets === 'object') {
    Object.assign(offsets, snap.offsets);
  }
}

// Apply one persisted usage record to a rollup. A `backfill` record (historical
// tokens attributed to a past day) contributes tokens/cost only; a normal turn
// record also counts as a turn (prompt + active time).
function applyUsageRecord(rollup, u) {
  const byModel = u.byModel && typeof u.byModel === 'object'
    ? u.byModel
    : { [u.model || 'unknown']: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } };
  const arg = { repoRoot: u.repo_root, repoName: u.repo_name, byModel, ts: u.ts };
  if (u.backfill) aggregate.accumulateTokensByModel(rollup, arg);
  else aggregate.accumulateTurnByModel(rollup, arg); // durationMs is ignored; active time is event-derived
}

// A day's rollup, derived PURELY from its durable usage log — the single source
// of truth. This is what keeps accounting crash-safe and idempotent: a past day
// is never trusted as a frozen file nor amended in place; it is recomputed from
// the log (which backfill only ever appends to), so a crash, a corrupt rollup
// file, or a re-ingest can neither double-count nor lose tokens.
// Tokens/prompts/cost only — from the usage log. Active time is added separately by
// the callers from the EVENT log (see addActiveFromEvents), so a caller that already
// has the day's events in hand doesn't read that log twice.
function deriveRollupFromUsage(date) {
  const rollup = aggregate.createRollup(date);
  for (const u of readJsonl(paths.usageLogPath(date))) applyUsageRecord(rollup, u);
  return rollup;
}

// Fold a day's event-derived active time (engaged-clock replay) into `rollup`. Active
// excludes permission/idle waits and includes background-workflow time, and — being a
// pure function of the durable per-day event log — stays crash-safe and matches the
// live per-session clock exactly (same applyEvent). Pass pre-read `events` to avoid a
// second read of the log.
function addActiveFromEvents(rollup, date, events) {
  aggregate.accumulateActiveFromEvents(rollup, events || readJsonl(paths.eventLogPath(date)));
  return rollup;
}

// Rebuild TODAY's rollup from today's usage log, plus per-repo session counts from
// today's event log (only the today card table shows session counts). Never trusts
// a possibly mid-write rollup file for the open day.
function rebuildTodayRollup() {
  todayRollup = deriveRollupFromUsage(currentDate);
  const events = readJsonl(paths.eventLogPath(currentDate)); // read once for both passes below
  addActiveFromEvents(todayRollup, currentDate, events); // active time (engaged clock)
  for (const ev of events) {
    if (ev.session_id != null && ev.repo_root != null) {
      aggregate.accumulateSession(todayRollup, {
        repoRoot: ev.repo_root,
        repoName: ev.repo_name,
        sessionId: ev.session_id,
        ts: ev.ts,
      });
    }
  }
}

// Seed a session's counted-message-id set from the DURABLE usage logs (the source
// of truth for what has already been billed), once per session per daemon lifetime.
// This keeps ingestion idempotent however the session got here — fresh daemon,
// restart, or a RESUME that reuses a session_id after its in-memory seenIds was
// dropped — so a whole-transcript re-read never re-appends a record or double-counts.
function ensureSeenSeeded(sid) {
  if (sid == null || primedSeen.has(sid)) return;
  primedSeen.add(sid);
  let files = [];
  try {
    files = fs.readdirSync(paths.usageDir());
  } catch (_e) {
    return;
  }
  let set = seenIds.get(sid);
  if (!set) seenIds.set(sid, (set = new Set()));
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    for (const u of readJsonl(paths.usageLogPath(m[1]))) {
      if (u.session_id === sid && Array.isArray(u.ids)) for (const id of u.ids) set.add(id);
    }
  }
}

// Back-fill token usage for turns whose Stop was logged while the daemon was down
// (it is only revived on SessionStart, so an extended outage can leave many
// completed turns unrecorded). For each active session, any completed transcript
// message not already counted (per the now fully-seeded seenIds) is ingested now.
// Idempotent via message ids, so it can never double-count; a gap turn's prompt
// boundary is unknown, so it contributes tokens/cost but zero active time.
function catchUpIngest() {
  for (const sid of Object.keys(state.sessions)) {
    const x = extra.get(sid);
    const tpath = x && x.transcriptPath;
    if (!tpath) continue;
    ensureSeenSeeded(sid); // seed from durable logs before deciding what's "fresh"
    let usage;
    try {
      usage = transcript.readUsage(tpath);
    } catch (_e) {
      continue;
    }
    if (!usage.ok) continue;
    const seen = seenIds.get(sid) || new Set();
    const fresh = usage.messages.filter((m) => !seen.has(m.id));
    if (fresh.length === 0) {
      updateSessionTokens(sid, usage);
      continue;
    }
    const s = state.sessions[sid];
    const stopEvent = { ts: s.lastActivityAt, repo_root: s.repoRoot, repo_name: s.repoName };
    recordTurn(sid, stopEvent, usage, fresh, seen);
  }
}

// ---- historical backfill (/internal/backfill) --------------------------------

// Where Claude Code keeps per-session transcripts (honoring CLAUDE_CONFIG_DIR):
// <base>/projects/<encoded-cwd>/<session_id>.jsonl.
function claudeProjectsDir() {
  const base = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects');
}

// Build, in ONE pass over the usage logs, a map of session_id -> Set(message ids
// already counted). Backfill dedups against this instead of the live seenIds/
// ensureSeenSeeded (which would be O(sessions x all-logs) and would bloat the live
// maps with historical sessions). The usage log is the durable source of truth, so
// this makes backfill idempotent and re-runnable.
function countedIdsBySession() {
  const map = new Map();
  let files;
  try {
    files = fs.readdirSync(paths.usageDir());
  } catch (_e) {
    return map;
  }
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m) continue;
    for (const u of readJsonl(paths.usageLogPath(m[1]))) {
      if (!u.session_id || !Array.isArray(u.ids)) continue;
      let s = map.get(u.session_id);
      if (!s) map.set(u.session_id, (s = new Set()));
      for (const id of u.ids) s.add(id);
    }
  }
  return map;
}

// Ingest token usage from EXISTING transcripts on disk — every past session for a
// repo (filterRepoRoot set) or across all repos (null), not just the sessions the
// daemon has observed live. Each transcript is read once, attributed to its repo
// (resolved from the transcript's own recorded cwd), bucketed by the day each
// message was spent, and deduped by message id (against a one-pass index of the
// durable usage logs) — so it is idempotent, re-runnable, and never double-counts
// against live ingestion. Sessions the daemon is tracking live are skipped by both
// session id and transcript PATH (a resume/fork reusing an old transcript file).
// Runs synchronously; a very large "all" scan can pause the daemon briefly.
function backfillTranscripts(filterRepoRoot) {
  const summary = {
    scope: filterRepoRoot ? 'repo' : 'all',
    transcripts: 0,
    sessionsIngested: 0,
    skippedActive: 0,
    newMessages: 0,
    tokens: emptyTokens(),
    byModel: {},
    repos: {}, // repoName -> { repoRoot, tokens, byModel }
    days: [],
  };
  const daySet = new Set();
  const counted = countedIdsBySession(); // one pass over the usage logs
  const liveTranscripts = new Set();
  for (const s of Object.keys(state.sessions)) {
    const x = extra.get(s);
    if (x && x.transcriptPath) liveTranscripts.add(x.transcriptPath);
  }
  let projects;
  try {
    projects = fs.readdirSync(claudeProjectsDir());
  } catch (_e) {
    return summary;
  }

  for (const proj of projects) {
    const dir = path.join(claudeProjectsDir(), proj);
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_e) {
      continue; // not a directory / unreadable
    }
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const sid = f.slice(0, -6);
      const tpath = path.join(dir, f);
      if (state.sessions[sid] || liveTranscripts.has(tpath)) {
        summary.skippedActive++;
        continue; // handled by live ingestion (by id, or by reused transcript path)
      }
      let usage;
      try {
        usage = transcript.readUsage(tpath);
      } catch (_e) {
        continue;
      }
      if (!usage.ok || usage.messages.length === 0 || !usage.cwd) continue;
      const repo = repoLib.resolveRepo(usage.cwd);
      if (filterRepoRoot && repo.repo_root !== filterRepoRoot) continue;
      summary.transcripts++;

      const seen = counted.get(sid) || new Set();
      const fresh = usage.messages.filter((m) => !seen.has(m.id));
      if (fresh.length === 0) continue;

      let maxTs = null;
      for (const m of fresh) if (m.ts && (!maxTs || m.ts > maxTs)) maxTs = m.ts;
      const stopEvent = { ts: maxTs, repo_root: repo.repo_root, repo_name: repo.repo_name };
      const groups = recordTurn(sid, stopEvent, usage, fresh, seen, /* allBackfill */ true);

      summary.sessionsIngested++;
      summary.newMessages += fresh.length;
      const rs =
        summary.repos[repo.repo_name] ||
        (summary.repos[repo.repo_name] = { repoRoot: repo.repo_root, tokens: emptyTokens(), byModel: {} });
      // Build the summary from the days recordTurn ACTUALLY wrote to, so the reported
      // date range and totals can never diverge from where the tokens landed.
      for (const [day, g] of groups) {
        daySet.add(day);
        addTokens(summary.tokens, g.totals);
        addTokens(rs.tokens, g.totals);
        for (const model of Object.keys(g.byModel)) {
          addTokens(summary.byModel[model] || (summary.byModel[model] = emptyTokens()), g.byModel[model]);
          addTokens(rs.byModel[model] || (rs.byModel[model] = emptyTokens()), g.byModel[model]);
        }
      }
    }
  }

  // Price the summary, then drop the internal byModel maps from the response.
  summary.cost = cfg.cost.enabled ? pricing.estimateCost(summary.byModel, cfg.cost.rates).total : null;
  delete summary.byModel;
  for (const name of Object.keys(summary.repos)) {
    const rs = summary.repos[name];
    rs.cost = cfg.cost.enabled ? pricing.estimateCost(rs.byModel, cfg.cost.rates).total : null;
    delete rs.byModel;
  }
  summary.days = [...daySet].sort();
  return summary;
}

// ---- event log tail ---------------------------------------------------------

// Read bytes appended since `offset`, returning only COMPLETE lines (a torn
// final line is left for the next read). Returns null if the file is absent.
function readNewLines(p, offset) {
  let st;
  try {
    st = fs.statSync(p);
  } catch (_e) {
    return null;
  }
  if (st.size < offset) offset = 0; // rotated / truncated -> restart
  if (st.size === offset) return { lines: [], newOffset: offset };

  const len = st.size - offset;
  const fd = fs.openSync(p, 'r');
  try {
    const buf = Buffer.allocUnsafe(len);
    const read = fs.readSync(fd, buf, 0, len, offset);
    const text = buf.subarray(0, read).toString('utf8');
    const lastNl = text.lastIndexOf('\n');
    if (lastNl === -1) return { lines: [], newOffset: offset }; // only a partial line so far
    const consumed = Buffer.byteLength(text.slice(0, lastNl + 1), 'utf8');
    return { lines: text.slice(0, lastNl).split('\n'), newOffset: offset + consumed };
  } finally {
    fs.closeSync(fd);
  }
}

function rolloverDay(today) {
  persistRollup(currentDate); // freeze the day we're leaving
  currentDate = today;
  offsets[currentDate] = 0;
  todayRollup = aggregate.createRollup(currentDate);
  rollupCache.clear(); // yesterday is now a past day — re-derive it on demand
  repoTotalsCache = null;
  // Break every session's engaged span at the day boundary so the live per-repo
  // active total matches the fresh per-day re-derivation (which starts each day with
  // no carried anchor). Without this, a span crossing midnight is folded whole into
  // the new day live but vanishes when that day is later re-derived — the same day's
  // active figure would change on rollover/restart.
  for (const sid of Object.keys(state.sessions)) state.sessions[sid].engagedSince = null;
}

// Read and apply any complete lines appended to a given day's event log since its
// last processed offset.
function drainLog(date) {
  const p = paths.eventLogPath(date);
  const off = offsets[date] || 0;
  const r = readNewLines(p, off);
  if (!r) return;
  offsets[date] = r.newOffset;
  for (const line of r.lines) {
    const t = line.trim();
    if (!t) continue;
    let ev;
    try {
      ev = JSON.parse(t);
    } catch (_e) {
      continue; // skip a torn / malformed line
    }
    handleEvent(ev);
  }
}

function tailOnce() {
  const today = paths.dateStr();
  if (today !== currentDate) {
    // Drain any trailing lines of the day we're leaving BEFORE freezing its
    // rollup — otherwise turns written between the last tail and midnight (that
    // day's log is never read again) would be silently lost from every rollup.
    drainLog(currentDate);
    rolloverDay(today);
  }
  drainLog(currentDate);
}

// ---- event handling ---------------------------------------------------------

function handleEvent(ev) {
  const sid = ev.session_id;

  aggregate.applyEvent(state, ev);

  if (sid != null && ev.transcript_path) {
    const x = extra.get(sid) || {};
    x.transcriptPath = ev.transcript_path;
    extra.set(sid, x);
  }

  const session = sid != null ? state.sessions[sid] : null;
  if (session && session.repoRoot) {
    aggregate.accumulateSession(todayRollup, {
      repoRoot: session.repoRoot,
      repoName: session.repoName,
      sessionId: sid,
      ts: ev.ts,
    });
  }

  if (replaying) return; // boot replay: rebuild live state only, no side effects

  // Fold the engaged-clock span this event just settled into today's per-repo active
  // total. The boot rebuild (deriveRollupFromUsage → accumulateActiveFromEvents)
  // already covered events up to startup; this extends it for each live event, using
  // the SAME delta the live per-session clock produced, so the two never diverge.
  if (session && session.repoRoot && session.activeDelta > 0) {
    const r = todayRollup.repos[session.repoRoot];
    if (r) {
      r.activeMs += session.activeDelta;
      repoTotalsCache = null; // all-time active changed
      // Mirror accumulateActiveFromEvents' by-hour bucketing so the History chart
      // (which reads todayRollup.hourActive) matches the live per-repo total.
      const t = Date.parse(ev.ts);
      if (Number.isFinite(t) && Array.isArray(todayRollup.hourActive)) {
        todayRollup.hourActive[new Date(t).getHours()] += session.activeDelta;
      }
    }
  }

  // Tally per-repo tool usage on its OWN PreToolUse branch — NOT alongside the
  // active-delta fold above, which is gated on activeDelta > 0. byTool is
  // unconditional (every PreToolUse with a tool_name): a PreToolUse can settle
  // activeDelta === 0 (first event after rolloverDay nulled engagedSince at
  // midnight, or a tool starting engagement from idle), and gating only this live
  // path would make today's byTool disagree with the accumulateActiveFromEvents
  // rescan on restart. accumulateSession (above) already ensured the repo entry.
  // Invalidate repoTotalsCache: the card's repo-total row now shows a Tools total.
  if (ev.event === 'PreToolUse' && ev.tool_name != null && session && session.repoRoot) {
    const r = todayRollup.repos[session.repoRoot];
    if (r) {
      r.byTool[ev.tool_name] = num(r.byTool[ev.tool_name]) + 1;
      repoTotalsCache = null;
    }
  }
  // Per-repo subagent count (same pattern) — feeds the card's Agents total.
  if (ev.event === 'SubagentStart' && session && session.repoRoot) {
    const r = todayRollup.repos[session.repoRoot];
    if (r) {
      r.subagents = num(r.subagents) + 1;
      repoTotalsCache = null;
    }
  }

  switch (ev.event) {
    case 'Stop':
      ingestTurn(sid, ev);
      break;
    case 'Notification':
      if (ev.notification_type === 'permission_prompt') maybeNotify('needsInput', session);
      break;
    case 'StopFailure':
      // A failed turn still spent tokens; ingest them like Stop so they aren't
      // lost if the session ends (dropSession) before any later Stop sweeps them.
      ingestTurn(sid, ev);
      maybeNotify('turnFailed', session);
      break;
    case 'SessionEnd':
      dropSession(sid);
      break;
    default:
      break;
  }

  // "Session finished" fires when the session actually finished working — the engaged→idle
  // transition that aggregate flags as `disengagedNow` AND has settled to `idle` — NOT merely
  // on Stop. Gating on the settled status being `idle` is essential: disengagedNow is also true
  // on running→waiting (a permission prompt, which fires needsInput) and running→error (fires
  // turnFailed), and on SessionEnd (status 'ended') — none of which are a finished turn. So a
  // Stop that handed off to a still-running background workflow (bgTasks>0, still engaged) stays
  // silent, and the notification lands only on the real completion (the Stop/SubagentStop that
  // empties background_tasks and settles the session to idle).
  if (session && session.disengagedNow && session.status === 'idle') {
    maybeNotify('sessionFinished', session);
  }

  lastBusyAt = Date.now();
  markDirty();
}

function dropSession(sid) {
  if (sid == null) return;
  delete state.sessions[sid];
  extra.delete(sid);
  seenIds.delete(sid);
  primedSeen.delete(sid); // a later resume re-seeds seenIds from the durable logs
  ingesting.delete(sid);
  pendingIngest.delete(sid);
}

// ---- token ingestion --------------------------------------------------------

// On Stop: read the transcript and fold any NEW assistant messages (by id) into
// the session totals and the day's rollup as one turn. The transcript is flushed
// asynchronously, so if no new usage is visible yet we retry with short backoff
// (total ~1.5s) rather than recording a wrong zero. Fully off the event loop.
function ingestTurn(sid, stopEvent) {
  if (sid == null) return;
  const x = extra.get(sid);
  const tpath = x && x.transcriptPath;
  if (!tpath) return; // no transcript -> time-only accounting for this session

  // Coalesce concurrent Stops for one session: a second Stop that arrives while a
  // retry chain is in flight is queued rather than run in parallel, so two chains
  // can't both pass the !seen filter for the same messages and record them twice.
  if (ingesting.has(sid)) {
    pendingIngest.set(sid, { stopEvent });
    return;
  }
  ingesting.add(sid);
  ensureSeenSeeded(sid); // (re)seed counted ids from durable logs so a re-read can't double-count

  const finish = () => {
    ingesting.delete(sid);
    const next = pendingIngest.get(sid);
    if (next) {
      pendingIngest.delete(sid);
      ingestTurn(sid, next.stopEvent); // run the queued Stop now
    }
  };

  const schedule = [0, 500, 1000, 1500];
  let i = 0;
  const attempt = () => {
    let usage;
    try {
      usage = transcript.readUsage(tpath);
    } catch (_e) {
      usage = { ok: false, messages: [], byModel: {}, totals: emptyTokens() };
    }
    const seen = seenIds.get(sid) || new Set();
    const fresh = usage.ok ? usage.messages.filter((m) => !seen.has(m.id)) : [];

    if (fresh.length === 0 && i < schedule.length - 1) {
      i += 1;
      setTimeout(attempt, schedule[i] - schedule[i - 1]);
      return;
    }
    if (fresh.length) recordTurn(sid, stopEvent, usage, fresh, seen);
    else if (usage.ok) updateSessionTokens(sid, usage); // refresh display even with no new turn
    markDirty();
    finish();
  };
  attempt();
}

function recordTurn(sid, stopEvent, usage, fresh, seen, allBackfill = false) {
  const session = state.sessions[sid];
  const repoRoot = (session && session.repoRoot) || stopEvent.repo_root || null;
  const repoName = (session && session.repoName) || stopEvent.repo_name || null;

  // Mark everything seen up front so a retry / re-read can never re-count it — but
  // ONLY for live sessions. Historical backfill dedups against a local index built
  // from the durable usage logs, so it must not populate (and unboundedly grow) the
  // live seenIds map with sessions that will never be ingested live again.
  if (!allBackfill) {
    for (const m of fresh) seen.add(m.id);
    seenIds.set(sid, seen);
  }

  // Attribute each message's tokens to the DAY it was actually spent (from its
  // transcript timestamp), clamped so a clock-skewed future stamp can't bucket into
  // a future day. Group the fresh messages by day.
  const groups = new Map(); // day -> { byModel, totals, ids, latestTs }
  for (const m of fresh) {
    let day = dayOf(m.ts) || dayOf(stopEvent.ts) || currentDate;
    if (day > currentDate) day = currentDate; // never bucket into a future day
    let g = groups.get(day);
    if (!g) groups.set(day, (g = { byModel: {}, totals: emptyTokens(), ids: [], latestTs: null }));
    addTokens(g.totals, m);
    const model = m.model || (session && session.model) || 'unknown';
    const bucket = g.byModel[model] || (g.byModel[model] = emptyTokens());
    addTokens(bucket, m);
    g.ids.push(m.id);
    if (m.ts && (!g.latestTs || m.ts > g.latestTs)) g.latestTs = m.ts;
  }

  // The just-completed turn is the group holding the MOST RECENT messages; it earns
  // the prompt count. Every older day is historical backfill (tokens/cost only).
  // Keying off the latest message — not the Stop's day — keeps the turn's prompt on
  // a real day even when it straddles midnight (Stop lands on the new day while the
  // messages are timestamped on the old one). (Active time is not turn-attributed —
  // it's derived from the event stream — so it needs no day-bucketing here.)
  // For a pure historical backfill (a whole pre-existing transcript) there is no
  // live turn — every group is attributed as backfill (tokens/cost only).
  let turnDay = null;
  if (!allBackfill) {
    let latestTs = null;
    for (const [day, g] of groups) {
      const t = g.latestTs || `${day}T00:00:00.000Z`;
      if (latestTs == null || t > latestTs) {
        latestTs = t;
        turnDay = day;
      }
    }
  }

  for (const [day, g] of groups) {
    const isTurn = day === turnDay;
    // Always a real timestamp (never null) so the record still lands in the hour
    // histogram: the Stop time for today's group, else the group's latest message
    // ts, else noon of that day.
    const ts = (day === currentDate && stopEvent.ts) || g.latestTs || `${day}T12:00:00.000Z`;
    // Append ONE record per day into THAT day's usage log — the durable source of
    // truth. Past days are recomputed from these logs on demand (getRollup), so we
    // never persist a past-day rollup here; only today's in-memory rollup is updated
    // live for the dashboard. `ids` keep the record idempotent across re-reads.
    appendUsage(
      {
        ts,
        session_id: sid,
        repo_root: repoRoot,
        repo_name: repoName,
        byModel: g.byModel,
        input: g.totals.input,
        output: g.totals.output,
        cacheRead: g.totals.cacheRead,
        cacheWrite: g.totals.cacheWrite,
        backfill: isTurn ? undefined : true,
        ids: g.ids,
      },
      day
    );
    if (day === currentDate) {
      if (isTurn) {
        aggregate.accumulateTurnByModel(todayRollup, { repoRoot, repoName, byModel: g.byModel, ts });
      } else {
        aggregate.accumulateTokensByModel(todayRollup, { repoRoot, repoName, byModel: g.byModel, ts });
      }
    }
  }

  updateSessionTokens(sid, usage);
  return groups; // day -> { byModel, totals, ids } — the actual attribution, for callers' summaries
}

function appendUsage(rec, date = currentDate) {
  try {
    fs.mkdirSync(paths.usageDir(), { recursive: true });
    fs.appendFileSync(paths.usageLogPath(date), JSON.stringify(rec) + '\n');
    repoTotalsCache = null; // tokens changed -> all-time totals are stale
    if (date !== currentDate) rollupCache.clear(); // a past day's data changed -> stale cache
  } catch (e) {
    log('usage append failed ' + e);
  }
}

// A per-message model id names a real, displayable model only if it isn't the
// 'unknown' bucket nor one of Claude Code's `<synthetic>` / `<...>` pseudo-model
// markers (written on synthetic transcript entries) — those must never surface as a
// real model in the chip or the "models this session" tooltip.
function isDisplayModel(m) {
  return typeof m === 'string' && m !== '' && m !== 'unknown' && m[0] !== '<';
}

function updateSessionTokens(sid, usage) {
  const session = state.sessions[sid];
  if (!session) return;
  session.tokens = usage.totals;
  session.cost = cfg.cost.enabled ? pricing.estimateCost(usage.byModel, cfg.cost.rates).total : null;
  // Backfill the session's DISPLAYED model from the transcript. The SessionStart
  // hook is the ONLY event that ever carries `model`, and it may omit it (docs:
  // optional), so a resumed session or one first seen after a snapshot loss shows
  // no model chip. Show the CURRENT model — the model of the most-recent transcript
  // message that actually GENERATED output (output > 0) — so a mid-session /model
  // switch is reflected on the next real turn. The output > 0 filter skips
  // usage-only/cache-only records that would otherwise flicker the chip across the
  // ~5s pollTokens re-reads; only overwrite when such a message is found, so a
  // transcript with no output-bearing message yet keeps the existing model.
  const messages = Array.isArray(usage.messages) ? usage.messages : [];
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    // Skip sidechain (subagent) turns: a subagent may run a different/cheaper model,
    // which isn't the SESSION's model and would mislabel the chip while it runs.
    if (m && !m.sidechain && isDisplayModel(m.model) && num(m.output) > 0) {
      session.model = m.model;
      break;
    }
  }
  // Full set of real models this session has used (first-seen order; 'unknown' and
  // `<synthetic>`-style pseudo-models dropped). Stored uncapped — the tooltip's
  // cap-at-5 is a client display concern.
  const bm = usage.byModel;
  if (bm && typeof bm === 'object') {
    session.modelsUsed = Object.keys(bm).filter(isDisplayModel);
  }
}

// ---- notifications ----------------------------------------------------------

function maybeNotify(eventName, session) {
  if (!session) return;
  const n = notify.buildNotification(eventName, session, cfg);
  if (n) notify.notify(n);
}

// ---- SSE broadcast ----------------------------------------------------------

function markDirty() {
  dirty = true;
  scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer) return;
  const since = Date.now() - lastFlush;
  const wait = since >= SSE_COALESCE_MS ? 0 : SSE_COALESCE_MS - since;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    if (dirty) broadcastState();
  }, wait);
}

function broadcastState() {
  dirty = false;
  lastFlush = Date.now();
  if (sseClients.size === 0) return;
  sseId += 1;
  const frame = `event: state\nid: ${sseId}\ndata: ${JSON.stringify(buildStatePayload())}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch (_e) {
      /* dead client is dropped on its own 'close' */
    }
  }
}

function broadcastConfig() {
  if (sseClients.size === 0) return;
  sseId += 1;
  const frame = `event: config\nid: ${sseId}\ndata: ${JSON.stringify(cfg)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(frame);
    } catch (_e) {
      /* ignore */
    }
  }
}

// ---- payload builders -------------------------------------------------------

function reposSummary() {
  const out = [];
  for (const root of Object.keys(todayRollup.repos)) {
    const r = todayRollup.repos[root];
    const cost = cfg.cost.enabled ? pricing.estimateCost(r.byModel, cfg.cost.rates).total : null;
    out.push({
      repoRoot: root,
      repoName: r.repoName,
      activeMs: r.activeMs,
      prompts: r.prompts,
      sessions: r.sessions.length,
      tokens: r.tokens,
      byTool: r.byTool,
      cost,
      lastActive: r.lastActive,
    });
  }
  return out;
}

// Per-repo all-time totals (tokens + estimated cost) keyed by repoRoot, so a Live
// card can show its repo's cumulative total beside the session's own. The two are
// different scopes — one session vs. every session + backfill for the repo — and are
// easy to mistake for a bug when they differ. Covers all retained history, which is
// now unbounded until the user manually cleans up (POST /api/data/cleanup).
// Memoized: buildStatePayload runs on the SSE broadcast hot path, so this must NOT
// re-scan the log dirs (listRollupDates) or re-aggregate every frame. The cache is
// invalidated wherever tokens, rollups, or cost config change.
function repoTotalsAllTime() {
  if (repoTotalsCache) return repoTotalsCache;
  const agg = aggregateReposAcrossDates(listRollupDates());
  const out = {};
  for (const root of Object.keys(agg)) {
    const bt = agg[root].byTool || {};
    let tools = 0;
    for (const k of Object.keys(bt)) tools += num(bt[k]);
    out[root] = {
      // prompts, activeMs, subagents, tools all count live turns/events only (backfill
      // can't reconstruct them), so they under-represent repos with imported history —
      // unlike tokens/cost.
      prompts: agg[root].prompts,
      activeMs: agg[root].activeMs,
      subagents: num(agg[root].subagents),
      tools,
      tokens: agg[root].tokens,
      cost: cfg.cost.enabled ? pricing.estimateCost(agg[root].byModel, cfg.cost.rates).total : null,
    };
  }
  repoTotalsCache = out;
  return out;
}

function buildStatePayload() {
  const now = Date.now();
  return {
    now,
    sessions: aggregate.snapshot(state, now).sessions,
    repos: reposSummary(),
    repoTotals: repoTotalsAllTime(),
    config: cfg,
    daemon: { version: VERSION, pluginPath: PLUGIN_PATH, port: PORT },
  };
}

// ---- history ----------------------------------------------------------------

function getRollup(date) {
  if (date === currentDate) return todayRollup;
  // Memoize the derive-from-log for past days — they change only via rare backfill
  // or day-rollover, both of which clear this cache — so History stays a fast
  // O(days) read instead of re-parsing every day's usage log on each request.
  let r = rollupCache.get(date);
  if (!r) {
    r = deriveRollupFromUsage(date); // tokens/prompts from the usage log
    addActiveFromEvents(r, date); // active time from the event log (one read, then cached)
    rollupCache.set(date, r);
  }
  return r;
}

function listRollupDates() {
  const set = new Set([currentDate]);
  // A day counts if it has a persisted rollup file OR a usage log — the latter
  // covers a past day that only ever received historical backfill.
  for (const dir of [paths.rollupsDir(), paths.usageDir()]) {
    let files = [];
    try {
      files = fs.readdirSync(dir);
    } catch (_e) {
      files = [];
    }
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\.(?:json|jsonl)$/);
      if (m) set.add(m[1]);
    }
  }
  return [...set].sort();
}

function datesInRange(range) {
  if (range === 'all') return listRollupDates();
  const n = range === 'today' ? 1 : range === '30d' ? 30 : 7;
  const out = [];
  const d = new Date();
  for (let i = 0; i < n; i++) {
    out.push(paths.dateStr(d));
    d.setDate(d.getDate() - 1);
  }
  return out.sort();
}

// Total estimated cost for one day's rollup, combining models across repos.
function dayCost(rollup) {
  if (!cfg.cost.enabled || !rollup || !rollup.repos) return null;
  const combined = {};
  for (const root of Object.keys(rollup.repos)) {
    const bm = rollup.repos[root].byModel || {};
    for (const m of Object.keys(bm)) {
      const dst = combined[m] || (combined[m] = emptyTokens());
      addTokens(dst, bm[m]);
    }
  }
  return pricing.estimateCost(combined, cfg.cost.rates).total;
}

// Aggregate per-repo tokens (total + per-model) and active time across a set of days,
// keyed by repoRoot. Shared by the History range view and the Live cards' all-time
// totals so the two can't diverge. getRollup memoizes past days, so this is O(days).
function aggregateReposAcrossDates(dates) {
  const agg = {}; // repoRoot -> { repoRoot, repoName, prompts, activeMs, tokens, byModel }
  for (const date of dates) {
    const rollup = getRollup(date);
    if (!rollup || !rollup.repos) continue;
    for (const root of Object.keys(rollup.repos)) {
      const rr = rollup.repos[root];
      const a = agg[root] || (agg[root] = { repoRoot: root, repoName: rr.repoName, prompts: 0, activeMs: 0, subagents: 0, tokens: emptyTokens(), byModel: {}, byTool: {} });
      if (rr.repoName) a.repoName = rr.repoName;
      a.prompts += num(rr.prompts);
      a.activeMs += num(rr.activeMs);
      a.subagents += num(rr.subagents);
      addTokens(a.tokens, rr.tokens);
      for (const m of Object.keys(rr.byModel || {})) {
        addTokens(a.byModel[m] || (a.byModel[m] = emptyTokens()), rr.byModel[m]);
      }
      for (const t of Object.keys(rr.byTool || {})) {
        a.byTool[t] = num(a.byTool[t]) + num(rr.byTool[t]);
      }
    }
  }
  return agg;
}

function buildHistory(rangeRaw) {
  const range = ['today', '7d', '30d', 'all'].includes(rangeRaw) ? rangeRaw : '7d';
  const dates = datesInRange(range);

  const perDay = [];
  for (const date of dates) {
    const rollup = getRollup(date);
    const tokens = emptyTokens();
    let activeMs = 0;
    if (rollup && rollup.repos) {
      for (const root of Object.keys(rollup.repos)) {
        const rr = rollup.repos[root];
        addTokens(tokens, rr.tokens);
        activeMs += num(rr.activeMs);
      }
    }
    perDay.push({ date, tokens, activeMs, cost: dayCost(rollup) });
  }

  const repoAgg = aggregateReposAcrossDates(dates);

  // Hour-of-day histogram. Active per hour comes from the rollup's pre-bucketed
  // hourActive (built once in the same cached event replay that produced the per-repo
  // active — no extra event-log scan, so this stays O(days)); it therefore matches the
  // daily/per-repo active figures exactly. Tokens per hour come from the small usage log.
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, activeMs: 0, tokens: 0 }));
  for (const date of dates) {
    const ha = getRollup(date).hourActive;
    if (Array.isArray(ha)) for (let h = 0; h < 24; h++) byHour[h].activeMs += num(ha[h]);
    for (const u of readJsonl(paths.usageLogPath(date))) {
      const t = Date.parse(u.ts);
      if (!Number.isFinite(t)) continue;
      byHour[new Date(t).getHours()].tokens += num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
    }
  }

  const topRepos = Object.values(repoAgg)
    .map((a) => ({
      repoRoot: a.repoRoot,
      repoName: a.repoName,
      activeMs: a.activeMs,
      tokens: a.tokens,
      byTool: a.byTool,
      cost: cfg.cost.enabled ? pricing.estimateCost(a.byModel, cfg.cost.rates).total : null,
    }))
    .sort((x, y) => y.activeMs - x.activeMs)
    .slice(0, 10);

  return { range, perDay, byHour, topRepos };
}

// ---- HTTP -------------------------------------------------------------------

function json(res, obj, code = 200) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// Reject cross-origin / non-localhost Host to block drive-by browser and
// DNS-rebinding calls; localhost bind alone is not access control.
function originHostOk(req) {
  const host = String(req.headers.host || '');
  const hostname = host.split(':')[0];
  if (hostname !== '127.0.0.1' && hostname !== 'localhost') return false;
  const origin = req.headers.origin;
  if (origin) {
    if (origin !== `http://127.0.0.1:${PORT}` && origin !== `http://localhost:${PORT}`) return false;
  }
  return true;
}

function authOk(req, url) {
  let t = null;
  const h = req.headers.authorization;
  if (h && h.startsWith('Bearer ')) t = h.slice(7).trim();
  if (!t) t = url.searchParams.get('token');
  if (!t) return false;
  const a = Buffer.from(t);
  const b = Buffer.from(TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function serveIndex(res) {
  let html;
  try {
    html = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  } catch (_e) {
    res.writeHead(500);
    res.end('dashboard not found');
    return;
  }
  html = html.replace('%%TOKEN%%', TOKEN);
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function serveStatic(res, pathname) {
  const [file, type] = STATIC[pathname];
  let body;
  try {
    body = fs.readFileSync(path.join(WEB_DIR, file));
  } catch (_e) {
    res.writeHead(404);
    res.end('not found');
    return;
  }
  res.writeHead(200, { 'Content-Type': type });
  res.end(body);
}

function serveHealth(res) {
  json(res, {
    ok: true,
    version: VERSION,
    pluginPath: PLUGIN_PATH,
    port: PORT,
    pid: process.pid,
    uptimeMs: Date.now() - startedAtMs,
  });
}

function serveStream(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');
  sseClients.add(res);
  lastBusyAt = Date.now();
  // Send an immediate full snapshot so a fresh client renders without waiting.
  sseId += 1;
  res.write(`event: state\nid: ${sseId}\ndata: ${JSON.stringify(buildStatePayload())}\n\n`);
  req.on('close', () => sseClients.delete(res));
}

function readBody(req, cb) {
  let data = '';
  let tooBig = false;
  req.on('data', (chunk) => {
    if (tooBig) return;
    data += chunk;
    if (data.length > 1e6) {
      tooBig = true;
      cb(null);
    }
  });
  req.on('end', () => {
    if (tooBig) return;
    cb(data);
  });
  req.on('error', () => cb(null));
}

function handlePutConfig(req, res) {
  readBody(req, (raw) => {
    let body;
    try {
      body = JSON.parse(raw || '');
    } catch (_e) {
      json(res, { errors: ['invalid JSON body'] }, 400);
      return;
    }
    const result = config.writeConfig(body); // validate + atomic persist
    if (!result.ok) {
      json(res, { errors: result.errors }, 400);
      return;
    }
    cfg = result.config; // hot-reload in-memory config
    repoTotalsCache = null; // rates / currency / cost.enabled may have changed
    broadcastConfig(); // every open dashboard reflects the change
    json(res, { ok: true, config: cfg });
  });
}

function handleInternalEvent(req, res) {
  // Wake nudge only — the body is NOT authoritative; we always read the log.
  readBody(req, () => {
    json(res, { ok: true });
    try {
      tailOnce();
    } catch (e) {
      log('nudge tail failed ' + e);
    }
  });
}

// Historical backfill trigger. Body: { all: true } for every repo, or { cwd }
// to scope to the repo containing that path (default is the caller's repo).
function handleBackfill(req, res) {
  readBody(req, (raw) => {
    let body = {};
    try {
      body = raw ? JSON.parse(raw) : {};
    } catch (_e) {
      body = {};
    }
    let filterRepoRoot = null;
    if (body.all === true) {
      filterRepoRoot = null; // explicit: every repo
    } else if (typeof body.cwd === 'string' && body.cwd.trim()) {
      filterRepoRoot = repoLib.resolveRepo(body.cwd).repo_root;
    } else {
      // Neither an explicit all nor a usable cwd — refuse rather than silently
      // backfilling every repo (e.g. when an empty ${CLAUDE_PROJECT_DIR} expands to "").
      return json(res, { ok: false, error: 'backfill requires {"cwd":"<path>"} for one repo or {"all":true} for everything' }, 400);
    }
    let summary;
    try {
      summary = backfillTranscripts(filterRepoRoot);
    } catch (e) {
      log('backfill failed ' + ((e && e.stack) || e));
      return json(res, { ok: false, error: String((e && e.message) || e) }, 500);
    }
    markDirty(); // surface any today-updates and let open dashboards refresh
    json(res, { ok: true, summary });
  });
}

// ---- data management (storage / cleanup / delete-repo) ----------------------

// A day-file basename: YYYY-MM-DD.json (rollups) or .jsonl (events/usage). The
// extension check also excludes an interrupted atomic write's `*.tmp` leftover,
// which would otherwise match a bare date-prefix test.
const DATE_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.(?:json|jsonl)$/;

// Sum the byte size of every file directly under `dir` (non-recursive); a missing
// dir counts as 0. A file that vanishes between readdir and stat is skipped.
function dirBytes(dir) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_e) {
    return 0;
  }
  let total = 0;
  for (const f of files) {
    try {
      total += fs.statSync(path.join(dir, f)).size;
    } catch (_e) {
      /* vanished */
    }
  }
  return total;
}

function fileBytes(p) {
  try {
    return fs.statSync(p).size;
  } catch (_e) {
    return 0;
  }
}

// Byte size of the three day-file dirs — the space a delete/cleanup actually frees
// (the snapshot delta is noise, so freedBytes is measured over these dirs only).
function storeBytes() {
  return dirBytes(paths.eventsDir()) + dirBytes(paths.usageDir()) + dirBytes(paths.rollupsDir());
}

// The 'YYYY-MM-DD' N days before today (local time). YYYY-MM-DD strings sort
// lexicographically by date, so a plain `date < cutoff` selects strictly-older days.
function cutoffDate(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return paths.dateStr(d);
}

// Run `fn(fullPath, date)` for each YYYY-MM-DD.{json,jsonl} day file under `dir` (the
// only shape DATE_FILE_RE matches — tmp files and other names are skipped). Tolerant of
// a missing dir; a throw in `fn` propagates to the caller.
function forEachDateFile(dir, fn) {
  let files;
  try {
    files = fs.readdirSync(dir);
  } catch (_e) {
    return;
  }
  for (const f of files) {
    const m = f.match(DATE_FILE_RE);
    if (!m) continue; // DATE_FILE_RE already restricts to YYYY-MM-DD.{json,jsonl}; tmp files don't match
    fn(path.join(dir, f), m[1]);
  }
}

// Atomically replace a jsonl day file with `kept` (tmp write + same-dir rename, the
// persistRollup/saveSnapshot pattern), or UNLINK it when nothing remains — so an
// emptied file stops counting toward the store's size and day span rather than
// lingering as a 0-byte file. Throws on I/O failure (caller's try/catch handles it).
function rewriteOrUnlinkJsonl(file, kept) {
  if (kept.length === 0) {
    try {
      fs.unlinkSync(file);
    } catch (_e) {
      /* already gone */
    }
    return;
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, kept.map((o) => JSON.stringify(o)).join('\n') + '\n');
  fs.renameSync(tmp, file);
}

// Remove one repo from a persisted rollup file; unlink the file if it then holds no
// repos. A file without this repo (or unreadable/malformed) is left untouched — its
// content is never trusted anyway (past days derive from the usage log).
function deleteRepoFromRollupFile(file, repoRoot) {
  let rollup;
  try {
    rollup = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_e) {
    return;
  }
  if (!rollup || typeof rollup !== 'object' || !rollup.repos || !(repoRoot in rollup.repos)) return;
  delete rollup.repos[repoRoot];
  if (Object.keys(rollup.repos).length === 0) {
    try {
      fs.unlinkSync(file);
    } catch (_e) {
      /* already gone */
    }
    return;
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rollup));
  fs.renameSync(tmp, file);
}

// GET /api/storage — on-disk size of the cockpit's accounting store, computed
// synchronously per request (a stat of a few dozen small files is cheap) and NEVER
// memoized or called from buildStatePayload, so it can't touch the SSE hot path.
// daemon.log lives in stateDir's root (not these dirs) and is deliberately excluded —
// it's a log, not accounting data. `days` is the count of DISTINCT YYYY-MM-DD dates
// present across the three dirs (their union); oldest/newest are the min/max of that
// union — a file count, not a calendar span (a gap day simply isn't counted).
function computeStorage() {
  const daySet = new Set();
  // One pass per dir: sum every file's size AND record the day-file dates together, so a
  // GET /api/storage does one readdir per dir, not two. Size counts all files present
  // (matching storeBytes/dirBytes); dates come only from YYYY-MM-DD.{json,jsonl} names.
  const scan = (dir) => {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_e) {
      return 0;
    }
    let total = 0;
    for (const f of files) {
      try {
        total += fs.statSync(path.join(dir, f)).size;
      } catch (_e) {
        /* vanished */
      }
      const m = f.match(DATE_FILE_RE);
      if (m) daySet.add(m[1]);
    }
    return total;
  };
  const dirs = {
    events: scan(paths.eventsDir()),
    usage: scan(paths.usageDir()),
    rollups: scan(paths.rollupsDir()),
    snapshot: fileBytes(paths.snapshotPath()),
  };
  const bytes = dirs.events + dirs.usage + dirs.rollups + dirs.snapshot;
  const sorted = [...daySet].sort();
  return {
    bytes,
    dirs,
    days: sorted.length,
    dates: sorted, // the exact day list, so the cleanup UI can preview precisely which days a cutoff removes
    oldestDate: sorted[0] || null,
    newestDate: sorted[sorted.length - 1] || null,
  };
}

// POST /api/data/cleanup — body { olderThanDays: N } (N>=1). Unlinks every whole
// YYYY-MM-DD.* file whose date is < (today - N) AND != today, across the three day-file
// dirs. This is the safe subset of the removed auto-prune: whole-file unlinks of
// inactive past days only — never today's file (hooks may be appending to it), no
// line-level rewrites, no concurrent writers. N is entered at click-time, not persisted.
function handleDataCleanup(req, res) {
  readBody(req, (raw) => {
    let body;
    try {
      body = JSON.parse(raw || '');
    } catch (_e) {
      return json(res, { ok: false, error: 'invalid JSON body' }, 400);
    }
    const v = body && body.olderThanDays;
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isInteger(n) || n < 1) {
      return json(res, { ok: false, error: 'olderThanDays must be an integer >= 1' }, 400);
    }
    try {
      const before = storeBytes();
      const cutoff = cutoffDate(n);
      const deletedDays = new Set();
      for (const dir of [paths.eventsDir(), paths.usageDir(), paths.rollupsDir()]) {
        forEachDateFile(dir, (file, date) => {
          if (date >= cutoff || date === currentDate) return; // keep recent days + today
          try {
            fs.unlinkSync(file);
            deletedDays.add(date);
          } catch (_e) {
            /* best effort */
          }
        });
      }
      // A pruned day drops out of every range aggregate — clear the memoized rollups
      // and the all-time totals so they no longer count the deleted days.
      rollupCache.clear();
      repoTotalsCache = null;
      markDirty();
      json(res, { ok: true, deletedDays: deletedDays.size, freedBytes: Math.max(0, before - storeBytes()) });
    } catch (e) {
      log('cleanup failed ' + ((e && e.stack) || e));
      json(res, { ok: false, error: String((e && e.message) || e) }, 500);
    }
  });
}

// POST /api/repos/delete — body { repoRoot }. Hard-deletes one repo's accounting from
// the store. Refuses with 409 if a live session still has this repoRoot (the delete
// would be immediately re-populated by its in-flight events), then removes every trace,
// unlinking any file left empty so it stops counting toward the store.
function handleReposDelete(req, res) {
  readBody(req, (raw) => {
    let body;
    try {
      body = JSON.parse(raw || '');
    } catch (_e) {
      return json(res, { ok: false, error: 'invalid JSON body' }, 400);
    }
    const repoRoot = body && typeof body.repoRoot === 'string' ? body.repoRoot : '';
    if (!repoRoot) return json(res, { ok: false, error: 'repoRoot (string) is required' }, 400);

    try {
      // Drain today's event log BEFORE the live-session guard, so a SessionStart that
      // emit.js appended after this request arrived is reflected in state.sessions — else
      // the guard could miss a session just now starting in this repo, this very tailOnce
      // would then ingest it, and the "deleted" repo would immediately reappear. Draining
      // first also performs any pending day rollover up front, so the day we pin stays put.
      tailOnce();
      const today = currentDate; // pin the day: the second tailOnce below can't shift which files we filter

      // Refuse while a live session still owns this repo (Resolved decisions: 409) — its
      // in-flight events would immediately re-populate whatever we delete.
      for (const sid of Object.keys(state.sessions)) {
        const s = state.sessions[sid];
        if (s && s.repoRoot === repoRoot) {
          return json(res, { ok: false, error: 'a live session exists for this repo; close it first' }, 409);
        }
      }

      const before = storeBytes();

      // (a) usage logs: drop this repo's lines from every day file (daemon is the
      // sole writer of usage, so this is race-free).
      forEachDateFile(paths.usageDir(), (file) => {
        rewriteOrUnlinkJsonl(file, readJsonl(file).filter((u) => u.repo_root !== repoRoot));
      });

      // (b) rollups: delete .repos[repoRoot]; unlink a rollup left with no repos.
      forEachDateFile(paths.rollupsDir(), (file) => {
        deleteRepoFromRollupFile(file, repoRoot);
      });

      // (c) PAST-day event logs (no writers, so race-free): line-filter + atomic rename.
      forEachDateFile(paths.eventsDir(), (file, date) => {
        if (date === today) return; // the hot current day is handled below
        rewriteOrUnlinkJsonl(file, readJsonl(file).filter((ev) => ev.repo_root !== repoRoot));
      });

      // (d) CURRENT-day event log — the sharp edge. The daemon tails this hottest file by a
      // persisted byte offset; readNewLines treats size<offset as truncation and restarts
      // from 0. So: (i) tailOnce() again to drain any appends that landed during (a)-(c),
      // so offsets[today] equals the file's size; (ii) read -> drop this repo's lines ->
      // atomic rewrite (unlink if empty); (iii) reset offsets[today] to the NEW (shrunk)
      // size, so the next tail sees "fully processed" rather than "truncated -> restart
      // from 0", which would re-read every surviving line and double-count the OTHER repos'
      // live state. A concurrent emit.js append landing in the read->rename window is lost —
      // a bounded, accepted cost of this rare, deliberate action. Offset persistence is
      // deferred to the saveSnapshot in step (e) so one write persists it with the rollup.
      tailOnce(); // (i)
      const todayLog = paths.eventLogPath(today);
      rewriteOrUnlinkJsonl(todayLog, readJsonl(todayLog).filter((ev) => ev.repo_root !== repoRoot)); // (ii)
      offsets[today] = fileBytes(todayLog); // (iii) 0 if the file was unlinked

      // (e) re-derive in-memory state from the now-filtered logs, then persist the new
      // offset + corrected rollup together (saveSnapshot), and refresh open dashboards.
      rebuildTodayRollup();
      rollupCache.clear();
      repoTotalsCache = null;
      saveSnapshot();
      markDirty();

      json(res, { ok: true, repoRoot, freedBytes: Math.max(0, before - storeBytes()) });
    } catch (e) {
      log('repo delete failed ' + ((e && e.stack) || e));
      json(res, { ok: false, error: String((e && e.message) || e) }, 500);
    }
  });
}

function handleRequest(req, res) {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
    const pathname = url.pathname;

    if (!originHostOk(req)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    // Public: the dashboard shell + its own static assets (browser <script>/<link>
    // loads can't carry a bearer header) and the unauthenticated health probe.
    // These expose no user data; cross-origin access is blocked by originHostOk.
    if (req.method === 'GET' && pathname === '/') return serveIndex(res);
    if (req.method === 'GET' && pathname === '/health') return serveHealth(res);
    if (req.method === 'GET' && STATIC[pathname]) return serveStatic(res, pathname);

    // Everything below carries user data / mutates state -> require the token.
    if (!authOk(req, url)) {
      res.writeHead(401);
      res.end('unauthorized');
      return;
    }

    if (req.method === 'GET' && pathname === '/api/state') return json(res, buildStatePayload());
    if (req.method === 'GET' && pathname === '/api/stream') return serveStream(req, res);
    if (req.method === 'GET' && pathname === '/api/history') return json(res, buildHistory(url.searchParams.get('range')));
    if (req.method === 'GET' && pathname === '/api/storage') return json(res, computeStorage());
    if (req.method === 'GET' && pathname === '/api/config') return json(res, cfg);
    if (req.method === 'PUT' && pathname === '/api/config') return handlePutConfig(req, res);
    if (req.method === 'POST' && pathname === '/api/data/cleanup') return handleDataCleanup(req, res);
    if (req.method === 'POST' && pathname === '/api/repos/delete') return handleReposDelete(req, res);
    if (req.method === 'POST' && pathname === '/internal/event') return handleInternalEvent(req, res);
    if (req.method === 'POST' && pathname === '/internal/backfill') return handleBackfill(req, res);

    res.writeHead(404);
    res.end('not found');
  } catch (e) {
    log('request error ' + ((e && e.stack) || e));
    try {
      res.writeHead(500);
      res.end('error');
    } catch (_e) {
      /* response already gone */
    }
  }
}

function startServer(cb) {
  server = http.createServer(handleRequest);
  let fellBack = false;

  const onListen = () => {
    PORT = server.address().port;
    try {
      fs.writeFileSync(paths.portPath(), String(PORT));
      fs.writeFileSync(paths.pidPath(), String(process.pid));
    } catch (e) {
      log('failed writing port/pid ' + e);
    }
    cb();
  };

  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE' && !fellBack) {
      // Stable default port taken -> ephemeral port; disables idle-shutdown so a
      // revived daemon never returns on a URL open tabs can't rediscover.
      fellBack = true;
      ephemeral = true;
      log(`port ${cfg.port} in use; falling back to an ephemeral port`);
      server.listen(0, '127.0.0.1');
      return;
    }
    log('fatal server error ' + e);
    cleanup();
    process.exit(1);
  });

  server.on('listening', onListen);
  server.listen(cfg.port, '127.0.0.1');
}

// ---- persistence ------------------------------------------------------------

function persistRollup(date) {
  // Only the open day is materialized to disk (as a fast-start cache); past days
  // are recomputed from their usage logs on demand, never persisted incrementally.
  const rollup = date === currentDate ? todayRollup : null;
  if (!rollup) return;
  try {
    fs.mkdirSync(paths.rollupsDir(), { recursive: true });
    const file = paths.rollupPath(date);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rollup));
    fs.renameSync(tmp, file);
  } catch (e) {
    log('rollup persist failed ' + e);
  }
}

function saveSnapshot() {
  const snap = {
    savedAt: new Date().toISOString(),
    now: Date.now(),
    currentDate,
    sessions: state.sessions,
    offsets,
    extra: Object.fromEntries(extra),
    seenIds: Object.fromEntries([...seenIds].map(([sid, set]) => [sid, [...set]])),
  };
  try {
    const file = paths.snapshotPath();
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(snap));
    fs.renameSync(tmp, file);
  } catch (e) {
    log('snapshot save failed ' + e);
  }
  persistRollup(currentDate); // keep the open day's rollup on disk too
}

// ---- background loops -------------------------------------------------------

function pollTokens() {
  for (const sid of Object.keys(state.sessions)) {
    const s = state.sessions[sid];
    if (s.status !== 'running') continue;
    const x = extra.get(sid);
    if (!x || !x.transcriptPath) continue;
    let usage;
    try {
      usage = transcript.readUsage(x.transcriptPath);
    } catch (_e) {
      continue;
    }
    if (!usage.ok) continue;
    const before = s.tokens;
    const changed = !before ||
      before.input !== usage.totals.input || before.output !== usage.totals.output ||
      before.cacheRead !== usage.totals.cacheRead || before.cacheWrite !== usage.totals.cacheWrite;
    if (changed) {
      updateSessionTokens(sid, usage); // display refresh only; rollup writes happen at Stop
      markDirty();
    }
  }
}

function checkLongRunning() {
  if (!cfg.events.longRunning) return;
  const now = Date.now();
  for (const sid of Object.keys(state.sessions)) {
    const s = state.sessions[sid];
    if (s.status !== 'running' || !s.currentPrompt) continue;
    const started = Date.parse(s.currentPrompt.startedAt);
    if (!Number.isFinite(started)) continue;
    if (now - started <= cfg.longRunningThresholdMs) continue;
    const x = extra.get(sid) || {};
    if (x.longRunPromptId === s.currentPrompt.promptId) continue; // already fired for this prompt
    x.longRunPromptId = s.currentPrompt.promptId;
    extra.set(sid, x);
    maybeNotify('longRunning', s);
  }
}

// Finalize sessions whose owning Claude Code process is gone (handles a missing
// SessionEnd after a force-quit). Keyed off the OWNER PID, not silence, so a
// long quiet build is never falsely reaped.
function reapStale() {
  const now = Date.now();
  let changed = false;
  for (const sid of Object.keys(state.sessions)) {
    const s = state.sessions[sid];
    const pid = s.ownerPid;
    const last = Date.parse(s.lastActivityAt);
    const idleMs = Number.isFinite(last) ? now - last : Infinity;
    let dead;
    if (pid) {
      // Reap a PID-dead session only after a short grace with no events. If the
      // hook's parent happens to be a transient per-hook shell (whose PID dies
      // immediately), this avoids reaping a session that is actively emitting
      // events; a genuinely force-quit session goes quiet and is reaped once past
      // the grace. An active session keeps lastActivityAt fresh, so it is safe.
      dead = !isAlive(pid) && idleMs > REAP_GRACE_MS;
    } else {
      // No known owner PID: fall back to a generous idle timeout.
      dead = idleMs > REAP_IDLE_FALLBACK_MS;
    }
    if (dead) {
      dropSession(sid);
      changed = true;
    }
  }
  if (changed) markDirty();
}

function heartbeat() {
  for (const res of sseClients) {
    try {
      res.write(':heartbeat\n\n');
    } catch (_e) {
      /* dropped on close */
    }
  }
}

function checkIdleShutdown() {
  if (cfg.idleShutdownHours <= 0 || ephemeral) return; // only on the stable port
  const active = Object.keys(state.sessions).length;
  if (active > 0 || sseClients.size > 0) {
    lastBusyAt = Date.now();
    return;
  }
  if (Date.now() - lastBusyAt > cfg.idleShutdownHours * 3600000) {
    log('idle shutdown');
    cleanup();
    process.exit(0);
  }
}

function startLoops() {
  setInterval(tailOnce, TAIL_MS);
  setInterval(pollTokens, TOKEN_POLL_MS);
  setInterval(checkLongRunning, LONGRUN_MS);
  setInterval(reapStale, REAPER_MS);
  setInterval(heartbeat, HEARTBEAT_MS);
  setInterval(saveSnapshot, SNAPSHOT_MS);
  setInterval(checkIdleShutdown, IDLE_CHECK_MS);
}

// ---- boot -------------------------------------------------------------------

function main() {
  paths.ensureDirs(); // the state dir must exist before we can create the lock file
  if (!acquireLock()) {
    log('another daemon already holds the lock; exiting');
    process.exit(0);
  }
  registerCleanup();
  cfg = config.readConfig();
  TOKEN = ensureToken();

  currentDate = paths.dateStr();
  loadSnapshot();
  rebuildTodayRollup();

  // Replay any un-processed tail of today's event log into live state, idempotent
  // by byte offset. Side effects (ingestion/notifications) are suppressed.
  replaying = true;
  try {
    tailOnce();
  } catch (e) {
    log('boot replay failed ' + e);
  }
  replaying = false;

  // Drop sessions that already ended before boot so they never appear as active.
  for (const sid of Object.keys(state.sessions)) {
    if (state.sessions[sid].status === 'ended') delete state.sessions[sid];
  }

  // Back-fill any turns that completed while the daemon was down, for sessions
  // still open across this restart. catchUpIngest seeds each session's counted-id
  // set from the durable usage logs first, so this is idempotent (message-id keyed).
  catchUpIngest();

  startServer(() => {
    log(`daemon up on http://127.0.0.1:${PORT} v${VERSION}${ephemeral ? ' (ephemeral)' : ''}`);
    startLoops();
  });
}

main();
