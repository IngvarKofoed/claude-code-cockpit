'use strict';

// Hook entry — the ONLY code that runs inside a Claude Code hook.
// Reads the hook payload from stdin (tolerant of empty/garbage), normalizes it
// to one event record (see CONTRACTS section 0), appends a single JSON line to
// today's event log, and best-effort nudges the daemon over localhost. It never
// depends on the daemon being up (the log is the source of truth) and it ALWAYS
// exits 0 — a hook may never block, hang, or fail a session.
//
// PRIVACY: this script must NEVER copy `user_input`, `message`, `tool_input`, or
// `tool_output` into the record. Only counts, names, and metadata are stored — the one
// thing read out of a tool result is a background task's opaque id (see bgLaunchId),
// validated against TASK_ID_RE so nothing but an id can reach the log. A shell's command
// is read only to classify it (looksLikeTestRun) and is never stored.

const fs = require('fs');
const { resolveRepo } = require('./repo');
const { MAX_TASK_IDS, isTaskId, bgLaunchId, looksLikeTestRun } = require('./bg-tasks');
// The account/subscription reader is shared with the daemon (which re-reads it as the
// LIVE account); see scripts/account.js.
const { readSubscription } = require('./account');
const { appendEvent, pingDaemon } = require('./event-log');

// Hard backstop so a stalled socket can never keep the hook process alive.
const EXIT_GUARD_MS = 400;

let exited = false;
function finish() {
  if (exited) return;
  exited = true;
  process.exit(0);
}

function logErr(err) {
  try {
    process.stderr.write(`[cockpit emit] ${(err && err.stack) || err}\n`);
  } catch (_e) {
    // stderr unavailable — nothing more we can do, still exit 0.
  }
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch (_e) {
    return '';
  }
}

function parsePayload(raw) {
  try {
    // Strip a leading BOM before parsing — JSON.parse rejects one, which would turn a
    // perfectly good payload into {} and emit a contentless event.
    const obj = JSON.parse(String(raw).replace(/^﻿/, ''));
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_e) {
    return {};
  }
}

// Assign only defined, non-null values so absent hook fields are omitted.
function setIf(obj, key, val) {
  if (val !== undefined && val !== null) obj[key] = val;
}

function buildRecord(payload) {
  const record = { ts: new Date().toISOString() };
  setIf(record, 'event', payload.hook_event_name);
  setIf(record, 'session_id', payload.session_id);
  record.owner_pid = process.ppid; // parent = Claude Code (or its launching shell)
  setIf(record, 'prompt_id', payload.prompt_id);

  if (typeof payload.cwd === 'string' && payload.cwd) {
    record.cwd = payload.cwd;
    const repo = resolveRepo(payload.cwd);
    record.repo_root = repo.repo_root;
    record.repo_name = repo.repo_name;
    record.branch = repo.branch; // may be null (detached HEAD / no repo) — kept as null
  }

  setIf(record, 'transcript_path', payload.transcript_path);
  setIf(record, 'permission_mode', payload.permission_mode);
  setIf(record, 'effort_level', payload.effort && payload.effort.level);
  setIf(record, 'model', payload.model);
  setIf(record, 'source', payload.source); // SessionStart: startup|resume|clear|compact
  setIf(record, 'tool_name', payload.tool_name);
  setIf(record, 'notification_type', payload.notification_type);
  // StopFailure carries the reason as `error_type`; reuse the `stop_reason` slot.
  if (payload.hook_event_name === 'StopFailure') {
    setIf(record, 'stop_reason', payload.error_type);
  } else {
    setIf(record, 'stop_reason', payload.stop_reason);
  }
  setIf(record, 'agent_type', payload.agent_type);
  setIf(record, 'reason', payload.reason);
  // Claude Code's task registry (Stop / SubagentStop, v2.1.145+): the COUNT of background
  // tasks still in flight — workflow / subagent / run_in_background shell / monitor / …. This
  // is the reliable "is the session still working after its turn's Stop" signal the daemon
  // uses for engagement (see aggregate.isEngaged). We store the length (plus the shell ids
  // below), never an element's command / description / name: those are free text (paths,
  // prompts, secrets) and persisting them would breach the "no message content" privacy
  // boundary. A present array (including empty) is authoritative; absent (older Claude Code)
  // leaves the daemon's last known count intact.
  //
  // bg_agents is the same count MINUS `type: 'shell'` entries — a background Bash or a
  // Monitor. A shell is in the registry but is not, by itself, the session working: a dev
  // server or file watcher sits there for hours, and counting every shell held the session
  // engaged for its whole lifetime, inflating active time and reporting a parked session as
  // not-at-rest. Shells stay in bg_tasks so the card's "N in flight" readout remains honest.
  // Denylist, not allowlist: an unrecognised future type keeps counting, as it does today.
  //
  // bg_shell_ids is the one exception to "counts only": the opaque ids of those shell
  // entries. A shell the session ended its turn waiting on (see bg_launch below) is work
  // until it leaves the registry, and only its id can say whether it has. bg_test_ids is the
  // subset whose command reads as a test run — work while it runs, however the turn ended.
  // Both hold random tokens, never the command or description.
  if (Array.isArray(payload.background_tasks)) {
    const isShell = (t) => t && typeof t === 'object' && t.type === 'shell';
    const shells = payload.background_tasks.filter(isShell).filter((t) => isTaskId(t.id));
    record.bg_tasks = payload.background_tasks.length;
    record.bg_agents = payload.background_tasks.filter((t) => !isShell(t)).length;
    record.bg_shell_ids = shells.map((t) => t.id).slice(0, MAX_TASK_IDS);
    record.bg_test_ids = shells
      .filter((t) => looksLikeTestRun(t.command))
      .map((t) => t.id)
      .slice(0, MAX_TASK_IDS);
  }
  // A background shell or Monitor this tool call just launched. The daemon treats a turn
  // that ENDS on such a launch as waiting on it: that is how a test run looks (launch, end
  // the turn, get woken by its completion), whereas a dev server is launched and then used.
  setIf(record, 'bg_launch', bgLaunchId(payload));
  // `agent_id` is present only on hooks fired from inside a subagent, so the daemon can tell
  // the main thread's tool calls (which decide what its turn ended on) from a subagent's. A
  // flag, not the id: presence is all that decision needs.
  if (typeof payload.agent_id === 'string' && payload.agent_id) record.subagent = true;
  // SessionStart captures the account/subscription once for the session's life, so a replay
  // reconstructs which account a session STARTED under. It is deliberately not re-read per
  // event (the file is a ~200KB blob and hooks are the hot path) — which is exactly why the
  // daemon keeps its own mtime-cached LIVE read for anything describing the account NOW
  // (usage bars, auto-pilot, a just-closed turn's attribution). See scripts/account.js.
  if (payload.hook_event_name === 'SessionStart') setIf(record, 'sub', readSubscription());
  return record;
}

function main() {
  const payload = parsePayload(readStdin());
  const record = buildRecord(payload);
  appendEvent(record); // durable source of truth — done before the best-effort ping
  pingDaemon(finish);
  // Backstop: exit even if the ping's own timeout never fires.
  setTimeout(finish, EXIT_GUARD_MS);
}

try {
  main();
} catch (err) {
  logErr(err);
  finish();
}
