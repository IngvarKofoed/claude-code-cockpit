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

const paths = require('./paths');
const config = require('./config');
const aggregate = require('./aggregate');
const transcript = require('./transcript');
const pricing = require('./pricing');
const notify = require('./notify');

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
const PRUNE_MS = 3600000;
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
const pendingIngest = new Map(); // session_id -> { stopEvent, promptStart } queued mid-ingest

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
  if (snap.sessions && typeof snap.sessions === 'object') state.sessions = snap.sessions;
  if (snap.extra && typeof snap.extra === 'object') {
    for (const sid of Object.keys(snap.extra)) extra.set(sid, snap.extra[sid]);
  }
  // Restore the counted-message-id sets so ingestion stays idempotent across a
  // restart independently of usage-log retention — a session older than
  // retentionDays whose early usage logs were pruned would otherwise have its old
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

// Re-derive TODAY's rollup fresh from today's durable logs (usage + events),
// per the crash-safety rule: never trust a possibly mid-write rollup for the
// open day. Also seeds seenIds from the usage log so live ingestion stays
// idempotent across restarts.
function rebuildTodayRollup() {
  todayRollup = aggregate.createRollup(currentDate);

  for (const u of readJsonl(paths.usageLogPath(currentDate))) {
    // Prefer the per-model split; fall back to a single-model record (older logs).
    const byModel = u.byModel && typeof u.byModel === 'object'
      ? u.byModel
      : { [u.model || 'unknown']: { input: u.input, output: u.output, cacheRead: u.cacheRead, cacheWrite: u.cacheWrite } };
    aggregate.accumulateTurnByModel(todayRollup, {
      repoRoot: u.repo_root,
      repoName: u.repo_name,
      byModel,
      durationMs: u.durationMs,
      ts: u.ts,
    });
    if (u.session_id && Array.isArray(u.ids)) {
      let s = seenIds.get(u.session_id);
      if (!s) seenIds.set(u.session_id, (s = new Set()));
      for (const id of u.ids) s.add(id);
    }
  }

  // Register every session seen today so repos with no completed turn still show.
  for (const ev of readJsonl(paths.eventLogPath(currentDate))) {
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

// After a restart, a session that is still open may carry transcript messages
// already counted on a PRIOR day (recorded in that day's usage log). Since
// rebuildTodayRollup only seeds seenIds from TODAY's usage log, seed the rest
// from the retention window's usage logs — for currently-active sessions only —
// so the next Stop can't re-count (and double-count into today) yesterday's tokens.
function seedSeenIdsHistory() {
  const active = new Set(Object.keys(state.sessions));
  if (active.size === 0) return;
  let files = [];
  try {
    files = fs.readdirSync(paths.usageDir());
  } catch (_e) {
    return;
  }
  for (const f of files) {
    const m = f.match(/^(\d{4}-\d{2}-\d{2})\.jsonl$/);
    if (!m || m[1] === currentDate) continue; // today's ids are seeded by rebuildTodayRollup
    for (const u of readJsonl(paths.usageLogPath(m[1]))) {
      if (!active.has(u.session_id) || !Array.isArray(u.ids)) continue;
      let s = seenIds.get(u.session_id);
      if (!s) seenIds.set(u.session_id, (s = new Set()));
      for (const id of u.ids) s.add(id);
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
    // Unknown prompt boundary -> promptStart null -> duration 0 for the gap turn.
    const stopEvent = { ts: s.lastActivityAt, repo_root: s.repoRoot, repo_name: s.repoName };
    recordTurn(sid, stopEvent, null, usage, fresh, seen);
  }
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
  const pre = sid != null ? state.sessions[sid] : null;
  // Capture the running prompt's start BEFORE Stop clears it, for turn duration.
  const promptStart = pre && pre.currentPrompt ? pre.currentPrompt.startedAt : null;

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

  switch (ev.event) {
    case 'Stop':
      ingestTurn(sid, ev, promptStart);
      maybeNotify('sessionFinished', session);
      break;
    case 'Notification':
      if (ev.notification_type === 'permission_prompt') maybeNotify('needsInput', session);
      break;
    case 'StopFailure':
      // A failed turn still spent tokens; ingest them like Stop so they aren't
      // lost if the session ends (dropSession) before any later Stop sweeps them.
      ingestTurn(sid, ev, promptStart);
      maybeNotify('turnFailed', session);
      break;
    case 'SessionEnd':
      dropSession(sid);
      break;
    default:
      break;
  }

  lastBusyAt = Date.now();
  markDirty();
}

function dropSession(sid) {
  if (sid == null) return;
  delete state.sessions[sid];
  extra.delete(sid);
  seenIds.delete(sid);
  ingesting.delete(sid);
  pendingIngest.delete(sid);
}

// ---- token ingestion --------------------------------------------------------

// On Stop: read the transcript and fold any NEW assistant messages (by id) into
// the session totals and the day's rollup as one turn. The transcript is flushed
// asynchronously, so if no new usage is visible yet we retry with short backoff
// (total ~1.5s) rather than recording a wrong zero. Fully off the event loop.
function ingestTurn(sid, stopEvent, promptStart) {
  if (sid == null) return;
  const x = extra.get(sid);
  const tpath = x && x.transcriptPath;
  if (!tpath) return; // no transcript -> time-only accounting for this session

  // Coalesce concurrent Stops for one session: a second Stop that arrives while a
  // retry chain is in flight is queued rather than run in parallel, so two chains
  // can't both pass the !seen filter for the same messages and record them twice.
  if (ingesting.has(sid)) {
    pendingIngest.set(sid, { stopEvent, promptStart });
    return;
  }
  ingesting.add(sid);

  const finish = () => {
    ingesting.delete(sid);
    const next = pendingIngest.get(sid);
    if (next) {
      pendingIngest.delete(sid);
      ingestTurn(sid, next.stopEvent, next.promptStart); // run the queued Stop now
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
    if (fresh.length) recordTurn(sid, stopEvent, promptStart, usage, fresh, seen);
    else if (usage.ok) updateSessionTokens(sid, usage); // refresh display even with no new turn
    markDirty();
    finish();
  };
  attempt();
}

function recordTurn(sid, stopEvent, promptStart, usage, fresh, seen) {
  const session = state.sessions[sid];
  const sum = emptyTokens();
  const byModel = {}; // per-model token split so a multi-model turn prices correctly
  for (const m of fresh) {
    addTokens(sum, m);
    const model = m.model || (session && session.model) || 'unknown';
    const bucket = byModel[model] || (byModel[model] = emptyTokens());
    addTokens(bucket, m);
    seen.add(m.id);
  }
  seenIds.set(sid, seen);

  let durationMs = 0;
  const a = Date.parse(promptStart);
  const b = Date.parse(stopEvent.ts);
  if (Number.isFinite(a) && Number.isFinite(b) && b >= a) durationMs = b - a;

  const repoRoot = (session && session.repoRoot) || stopEvent.repo_root || null;
  const repoName = (session && session.repoName) || stopEvent.repo_name || null;

  // Persist the turn: `ids` make the record idempotent across restarts; `byModel`
  // lets rebuildTodayRollup re-price each model at its own rate; the top-level
  // token totals feed the hour histogram.
  appendUsage({
    ts: stopEvent.ts,
    session_id: sid,
    repo_root: repoRoot,
    repo_name: repoName,
    byModel,
    input: sum.input,
    output: sum.output,
    cacheRead: sum.cacheRead,
    cacheWrite: sum.cacheWrite,
    durationMs,
    ids: fresh.map((m) => m.id),
  });

  aggregate.accumulateTurnByModel(todayRollup, { repoRoot, repoName, byModel, durationMs, ts: stopEvent.ts });
  updateSessionTokens(sid, usage);
}

function appendUsage(rec) {
  try {
    fs.mkdirSync(paths.usageDir(), { recursive: true });
    fs.appendFileSync(paths.usageLogPath(currentDate), JSON.stringify(rec) + '\n');
  } catch (e) {
    log('usage append failed ' + e);
  }
}

function updateSessionTokens(sid, usage) {
  const session = state.sessions[sid];
  if (!session) return;
  session.tokens = usage.totals;
  session.cost = cfg.cost.enabled ? pricing.estimateCost(usage.byModel, cfg.cost.rates).total : null;
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
      cost,
      lastActive: r.lastActive,
    });
  }
  return out;
}

function buildStatePayload() {
  const now = Date.now();
  return {
    now,
    sessions: aggregate.snapshot(state, now).sessions,
    repos: reposSummary(),
    config: cfg,
    daemon: { version: VERSION, pluginPath: PLUGIN_PATH, port: PORT },
  };
}

// ---- history ----------------------------------------------------------------

function getRollup(date) {
  if (date === currentDate) return todayRollup;
  try {
    return JSON.parse(fs.readFileSync(paths.rollupPath(date), 'utf8'));
  } catch (_e) {
    return null;
  }
}

function listRollupDates() {
  let files = [];
  try {
    files = fs.readdirSync(paths.rollupsDir());
  } catch (_e) {
    files = [];
  }
  const set = new Set(files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)));
  set.add(currentDate);
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

function buildHistory(rangeRaw) {
  const range = ['today', '7d', '30d', 'all'].includes(rangeRaw) ? rangeRaw : '7d';
  const dates = datesInRange(range);

  const perDay = [];
  const repoAgg = {}; // repoRoot -> aggregate across the range
  for (const date of dates) {
    const rollup = getRollup(date);
    const tokens = emptyTokens();
    let activeMs = 0;
    if (rollup && rollup.repos) {
      for (const root of Object.keys(rollup.repos)) {
        const rr = rollup.repos[root];
        addTokens(tokens, rr.tokens);
        activeMs += num(rr.activeMs);
        const a = repoAgg[root] || (repoAgg[root] = { repoRoot: root, repoName: rr.repoName, activeMs: 0, tokens: emptyTokens(), byModel: {} });
        a.activeMs += num(rr.activeMs);
        if (rr.repoName) a.repoName = rr.repoName;
        addTokens(a.tokens, rr.tokens);
        for (const m of Object.keys(rr.byModel || {})) {
          const bm = a.byModel[m] || (a.byModel[m] = emptyTokens());
          addTokens(bm, rr.byModel[m]);
        }
      }
    }
    perDay.push({ date, tokens, activeMs, cost: dayCost(rollup) });
  }

  // Hour-of-day histogram from the per-turn usage log (rollups have no hour granularity).
  const byHour = Array.from({ length: 24 }, (_, hour) => ({ hour, activeMs: 0, tokens: 0 }));
  for (const date of dates) {
    for (const u of readJsonl(paths.usageLogPath(date))) {
      const t = Date.parse(u.ts);
      if (!Number.isFinite(t)) continue;
      const h = new Date(t).getHours();
      byHour[h].activeMs += num(u.durationMs);
      byHour[h].tokens += num(u.input) + num(u.output) + num(u.cacheRead) + num(u.cacheWrite);
    }
  }

  const topRepos = Object.values(repoAgg)
    .map((a) => ({
      repoRoot: a.repoRoot,
      repoName: a.repoName,
      activeMs: a.activeMs,
      tokens: a.tokens,
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
    if (req.method === 'GET' && pathname === '/api/config') return json(res, cfg);
    if (req.method === 'PUT' && pathname === '/api/config') return handlePutConfig(req, res);
    if (req.method === 'POST' && pathname === '/internal/event') return handleInternalEvent(req, res);

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

function pruneOld() {
  if (!(cfg.retentionDays > 0)) return; // 0 / unset = keep forever; never wipe history
  const cutoff = Date.now() - cfg.retentionDays * 86400000;
  const dirs = [paths.eventsDir(), paths.usageDir(), paths.rollupsDir()];
  for (const dir of dirs) {
    let files;
    try {
      files = fs.readdirSync(dir);
    } catch (_e) {
      continue;
    }
    for (const f of files) {
      const m = f.match(/^(\d{4}-\d{2}-\d{2})\./);
      if (!m) continue;
      if (m[1] === currentDate) continue; // never touch the day hooks may be appending to
      const t = Date.parse(m[1]);
      if (Number.isFinite(t) && t < cutoff) {
        try {
          fs.unlinkSync(path.join(dir, f));
        } catch (_e) {
          /* best effort */
        }
      }
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
  setInterval(pruneOld, PRUNE_MS);
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

  // Reconcile token accounting for sessions still open across this restart: seed
  // the already-counted message ids from history, then back-fill any turns that
  // completed while the daemon was down. Both are idempotent (message-id keyed).
  seedSeenIdsHistory();
  catchUpIngest();

  startServer(() => {
    log(`daemon up on http://127.0.0.1:${PORT} v${VERSION}${ephemeral ? ' (ephemeral)' : ''}`);
    startLoops();
  });
}

main();
