'use strict';

// The hook-side writers for the durable event log, shared by every script that runs
// inside a Claude Code hook (`emit.js` for the event stream, `ensure.js` for the
// one-shot owner probe). Hook processes are the event log's ONLY writers — the
// daemon owns the usage and rollup stores — so keeping the append and the wake-up
// nudge in one place keeps that single-writer contract in one place too.

const fs = require('fs');
const http = require('http');
const path = require('path');
const paths = require('./paths');

// Best-effort daemon ping budget; the durable append already happened by then.
const PING_TIMEOUT_MS = 150;

function readTrim(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').trim();
  } catch (_e) {
    return '';
  }
}

// Append one object as a single JSON line to a JSONL file, creating its parent
// dir first. A single small-line append is atomic on local filesystems; the
// daemon's reader tolerates a torn final line where it isn't guaranteed.
function writeJsonlLine(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, JSON.stringify(obj) + '\n');
}

function appendEvent(record) {
  writeJsonlLine(paths.eventLogPath(paths.dateStr()), record);
}

// Wake-up nudge only — carries no authoritative data (the body is ignored by the
// daemon, which always re-reads the log). Never blocks past PING_TIMEOUT_MS, and
// never throws: a down daemon is normal, and the append above already persisted.
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
      {
        host: '127.0.0.1',
        port,
        path: '/internal/event',
        method: 'POST',
        timeout: PING_TIMEOUT_MS,
        headers,
      },
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

module.exports = { PING_TIMEOUT_MS, readTrim, writeJsonlLine, appendEvent, pingDaemon };
