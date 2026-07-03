'use strict';

// Hook entry — the ONLY code that runs inside a Claude Code hook.
// Reads the hook payload from stdin (tolerant of empty/garbage), normalizes it
// to one event record (see CONTRACTS section 0), appends a single JSON line to
// today's event log, and best-effort nudges the daemon over localhost. It never
// depends on the daemon being up (the log is the source of truth) and it ALWAYS
// exits 0 — a hook may never block, hang, or fail a session.
//
// PRIVACY: this script must NEVER copy `user_input`, `message`, `tool_input`, or
// `tool_output` into the record. Only counts, names, and metadata are stored.

const fs = require('fs');
const http = require('http');
const paths = require('./paths');
const { resolveRepo } = require('./repo');

// Best-effort daemon ping budget; the durable append already happened by then.
const PING_TIMEOUT_MS = 150;
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
    const obj = JSON.parse(raw);
    return obj && typeof obj === 'object' ? obj : {};
  } catch (_e) {
    return {};
  }
}

function readTrim(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_e) {
    return '';
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
  return record;
}

function appendEvent(record) {
  const line = JSON.stringify(record) + '\n';
  fs.mkdirSync(paths.eventsDir(), { recursive: true });
  // A single small-line append is atomic on local filesystems; the daemon's
  // reader tolerates a torn final line where it isn't guaranteed.
  fs.appendFileSync(paths.eventLogPath(paths.dateStr()), line);
}

// Wake-up nudge only — carries no authoritative data (body is ignored by the
// daemon, which always re-reads the log). Never blocks past PING_TIMEOUT_MS.
function pingDaemon(done) {
  let called = false;
  const complete = () => {
    if (called) return;
    called = true;
    done();
  };
  try {
    const port = parseInt(readTrim(paths.portPath()), 10);
    if (!port) return complete();
    const token = readTrim(paths.tokenPath());
    const body = '{}';
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(body),
    };
    if (token) headers.authorization = `Bearer ${token}`;
    const req = http.request(
      { host: '127.0.0.1', port, path: '/internal/event', method: 'POST', timeout: PING_TIMEOUT_MS, headers },
      (res) => {
        res.resume(); // drain so the socket can close
        res.on('end', complete);
        res.on('error', complete);
      }
    );
    req.on('timeout', () => {
      req.destroy();
      complete();
    });
    req.on('error', complete);
    req.write(body);
    req.end();
  } catch (_e) {
    complete();
  }
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
