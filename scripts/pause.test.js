'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  isPaused,
  sentinelReason,
  gateDecision,
  readPauseState,
  writePauseState,
  newPauseAcc,
  foldPauseEvent,
  pauseStateOf,
  foldPauseState,
  autoPauseDecision,
} = require('./pause');

// ---- isPaused / sentinelReason -----------------------------------------

test('isPaused: true for both paused sentinels, false for running/empty/garbage', () => {
  assert.strictEqual(isPaused('paused'), true);
  assert.strictEqual(isPaused('paused-usage'), true);
  assert.strictEqual(isPaused('running'), false);
  assert.strictEqual(isPaused(''), false);
  assert.strictEqual(isPaused('garbage'), false);
  assert.strictEqual(isPaused(null), false);
  assert.strictEqual(isPaused(undefined), false);
});

test('isPaused: trims surrounding whitespace before matching', () => {
  assert.strictEqual(isPaused('  paused  '), true);
  assert.strictEqual(isPaused('\npaused-usage\n'), true);
  // Whitespace-only content trims to '' -> not paused.
  assert.strictEqual(isPaused('   '), false);
});

test('sentinelReason: maps paused -> manual, paused-usage -> usage, unknown -> null', () => {
  assert.strictEqual(sentinelReason('paused'), 'manual');
  assert.strictEqual(sentinelReason('paused-usage'), 'usage');
  assert.strictEqual(sentinelReason('running'), null);
  assert.strictEqual(sentinelReason(''), null);
  assert.strictEqual(sentinelReason('garbage'), null);
  assert.strictEqual(sentinelReason(null), null);
});

test('sentinelReason: trims surrounding whitespace before matching', () => {
  assert.strictEqual(sentinelReason('  paused  '), 'manual');
  assert.strictEqual(sentinelReason('  paused-usage  '), 'usage');
});

// ---- gateDecision -------------------------------------------------------

test('gateDecision: enabled + a paused sentinel -> wait', () => {
  assert.strictEqual(gateDecision('paused', true), 'wait');
  assert.strictEqual(gateDecision('paused-usage', true), 'wait');
});

test('gateDecision: enabled + running/empty/garbage/whitespace -> run', () => {
  assert.strictEqual(gateDecision('running', true), 'run');
  assert.strictEqual(gateDecision('', true), 'run');
  assert.strictEqual(gateDecision('garbage', true), 'run');
  assert.strictEqual(gateDecision('   ', true), 'run');
  assert.strictEqual(gateDecision(null, true), 'run');
  assert.strictEqual(gateDecision(undefined, true), 'run');
});

test('gateDecision: disabled + any content -> run (fail-open)', () => {
  assert.strictEqual(gateDecision('paused', false), 'run');
  assert.strictEqual(gateDecision('paused-usage', false), 'run');
  assert.strictEqual(gateDecision('running', false), 'run');
  assert.strictEqual(gateDecision('garbage', false), 'run');
});

test('gateDecision: non-boolean enabled -> run, even over a paused sentinel', () => {
  assert.strictEqual(gateDecision('paused', 'true'), 'run');
  assert.strictEqual(gateDecision('paused', 1), 'run');
  assert.strictEqual(gateDecision('paused', undefined), 'run');
  assert.strictEqual(gateDecision('paused', null), 'run');
});

// ---- foldPauseState ------------------------------------------------------

test('foldPauseState: a single balanced span sums its duration and closes', () => {
  const res = foldPauseState([
    { ts: '2026-07-09T10:00:00.000Z', event: 'Paused', reason: 'manual' },
    { ts: '2026-07-09T10:05:00.000Z', event: 'Resumed' },
  ]);
  assert.deepStrictEqual(res, { paused: false, pausedSince: null, pausedMs: 5 * 60 * 1000, reason: null });
});

test('foldPauseState: multiple balanced spans sum across all of them', () => {
  const res = foldPauseState([
    { ts: '2026-07-09T10:00:00.000Z', event: 'Paused' },
    { ts: '2026-07-09T10:02:00.000Z', event: 'Resumed' },
    { ts: '2026-07-09T10:10:00.000Z', event: 'Paused' },
    { ts: '2026-07-09T10:13:00.000Z', event: 'Resumed' },
  ]);
  assert.strictEqual(res.paused, false);
  assert.strictEqual(res.pausedMs, 2 * 60 * 1000 + 3 * 60 * 1000);
});

test('foldPauseState: a still-open trailing span reports paused/since/reason and is EXCLUDED from pausedMs', () => {
  const res = foldPauseState([
    { ts: '2026-07-09T10:00:00.000Z', event: 'Paused' },
    { ts: '2026-07-09T10:02:00.000Z', event: 'Resumed' }, // closed span: 2 min
    { ts: '2026-07-09T11:00:00.000Z', event: 'Paused', reason: 'usage' }, // still open
  ]);
  assert.strictEqual(res.paused, true);
  assert.strictEqual(res.pausedSince, '2026-07-09T11:00:00.000Z');
  assert.strictEqual(res.reason, 'usage');
  // Only the closed 2-minute span counts; the open span contributes nothing
  // (the client adds the live now - pausedSince slice itself).
  assert.strictEqual(res.pausedMs, 2 * 60 * 1000);
});

test('foldPauseState: a double Paused keeps the FIRST open ts and reason (second is a no-op)', () => {
  const res = foldPauseState([
    { ts: '2026-07-09T10:00:00.000Z', event: 'Paused', reason: 'manual' },
    { ts: '2026-07-09T10:01:00.000Z', event: 'Paused', reason: 'usage' }, // ignored: already open
    { ts: '2026-07-09T10:05:00.000Z', event: 'Resumed' },
  ]);
  assert.strictEqual(res.paused, false);
  assert.strictEqual(res.pausedMs, 5 * 60 * 1000); // measured from the FIRST Paused
});

test('foldPauseState: a stray Resumed with no open span is ignored, never throws', () => {
  assert.doesNotThrow(() => {
    const res = foldPauseState([
      { ts: '2026-07-09T10:00:00.000Z', event: 'Resumed' },
      { ts: '2026-07-09T10:05:00.000Z', event: 'Resumed' },
    ]);
    assert.strictEqual(res.paused, false);
    assert.strictEqual(res.pausedMs, 0);
  });
});

test('foldPauseState: out-of-order records are sorted internally before folding', () => {
  const res = foldPauseState([
    { ts: '2026-07-09T10:05:00.000Z', event: 'Resumed' },
    { ts: '2026-07-09T10:00:00.000Z', event: 'Paused' }, // appears second in the array, earlier in time
  ]);
  assert.strictEqual(res.paused, false);
  assert.strictEqual(res.pausedMs, 5 * 60 * 1000);
});

test('foldPauseState: malformed / non-object entries and unknown event names are skipped, never throw', () => {
  assert.doesNotThrow(() => {
    const res = foldPauseState([
      null,
      undefined,
      'not-an-object',
      42,
      { event: 'SomethingElse', ts: '2026-07-09T10:00:00.000Z' },
      { ts: '2026-07-09T10:00:00.000Z', event: 'Paused' },
      { ts: '2026-07-09T10:03:00.000Z', event: 'Resumed' },
    ]);
    assert.strictEqual(res.paused, false);
    assert.strictEqual(res.pausedMs, 3 * 60 * 1000);
  });
});

test('foldPauseState: unparseable timestamps never throw and yield a finite pausedMs', () => {
  assert.doesNotThrow(() => {
    const res = foldPauseState([
      { ts: 'not-a-date', event: 'Paused' },
      { ts: '2026-07-09T10:00:00.000Z', event: 'Resumed' },
    ]);
    assert.ok(Number.isFinite(res.pausedMs));
    assert.ok(res.pausedMs >= 0);
  });
});

test('foldPauseState: empty / non-array input -> running, zero, never throws', () => {
  assert.deepStrictEqual(foldPauseState([]), { paused: false, pausedSince: null, pausedMs: 0, reason: null });
  assert.deepStrictEqual(foldPauseState(null), { paused: false, pausedSince: null, pausedMs: 0, reason: null });
  assert.deepStrictEqual(foldPauseState(undefined), { paused: false, pausedSince: null, pausedMs: 0, reason: null });
});

// ---- autoPauseDecision ---------------------------------------------------

test('autoPauseDecision: rising edge over the threshold while running -> pause', () => {
  assert.strictEqual(
    autoPauseDecision({ prevPct: 90, curPct: 96, threshold: 95, sentinel: 'running' }),
    'pause',
  );
  // Absent/empty sentinel behaves like 'running'.
  assert.strictEqual(
    autoPauseDecision({ prevPct: 90, curPct: 96, threshold: 95, sentinel: '' }),
    'pause',
  );
});

test('autoPauseDecision: never fires a pause over an existing manual "paused" sentinel', () => {
  assert.strictEqual(
    autoPauseDecision({ prevPct: 90, curPct: 96, threshold: 95, sentinel: 'paused' }),
    'none',
  );
});

test('autoPauseDecision: window reset (paused-usage, dropping back below threshold) -> resume', () => {
  assert.strictEqual(
    autoPauseDecision({ prevPct: 97, curPct: 80, threshold: 95, sentinel: 'paused-usage' }),
    'resume',
  );
});

test('autoPauseDecision: no re-pause / re-resume without a fresh crossing -> none', () => {
  // Already over threshold on both readings while running: no rising edge.
  assert.strictEqual(
    autoPauseDecision({ prevPct: 96, curPct: 97, threshold: 95, sentinel: 'running' }),
    'none',
  );
  // Already paused-usage and still over threshold: no reset condition met.
  assert.strictEqual(
    autoPauseDecision({ prevPct: 96, curPct: 97, threshold: 95, sentinel: 'paused-usage' }),
    'none',
  );
});

test('autoPauseDecision: threshold <= 0 (or non-finite) always -> none', () => {
  assert.strictEqual(autoPauseDecision({ prevPct: 0, curPct: 100, threshold: 0, sentinel: 'running' }), 'none');
  assert.strictEqual(autoPauseDecision({ prevPct: 0, curPct: 100, threshold: -5, sentinel: 'running' }), 'none');
  assert.strictEqual(autoPauseDecision({ prevPct: 0, curPct: 100, threshold: NaN, sentinel: 'running' }), 'none');
  assert.strictEqual(autoPauseDecision({ prevPct: 0, curPct: 100, threshold: undefined, sentinel: 'running' }), 'none');
  assert.strictEqual(autoPauseDecision({}), 'none');
});

test('autoPauseDecision: a null/undefined prevPct is treated as 0', () => {
  assert.strictEqual(
    autoPauseDecision({ prevPct: null, curPct: 10, threshold: 5, sentinel: 'running' }),
    'pause',
  );
  assert.strictEqual(
    autoPauseDecision({ prevPct: undefined, curPct: 10, threshold: 5, sentinel: 'running' }),
    'pause',
  );
});

test('autoPauseDecision: a null/undefined curPct is treated as 0 (no rising edge, no reset)', () => {
  assert.strictEqual(
    autoPauseDecision({ prevPct: 90, curPct: null, threshold: 95, sentinel: 'running' }),
    'none',
  );
  // paused-usage with cur treated as 0 IS below threshold -> resume.
  assert.strictEqual(
    autoPauseDecision({ prevPct: 90, curPct: undefined, threshold: 95, sentinel: 'paused-usage' }),
    'resume',
  );
});

// ---- readPauseState / writePauseState round-trip -------------------------
// Mirrors config.test.js's pattern: paths.js reads its env vars lazily on
// every call, so redirecting XDG_STATE_HOME (and the Windows equivalents) to
// a temp dir keeps this off the real state dir.

test('readPauseState/writePauseState: round-trip through a temp state dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-pause-'));
  const envKeys = ['XDG_STATE_HOME', 'LOCALAPPDATA', 'HOME', 'USERPROFILE'];
  const saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  try {
    process.env.XDG_STATE_HOME = path.join(tmp, 'state');
    process.env.LOCALAPPDATA = path.join(tmp, 'localappdata');
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;

    // No file yet -> readPauseState returns '' (never throws).
    assert.strictEqual(readPauseState(), '');

    writePauseState('paused');
    assert.strictEqual(readPauseState(), 'paused');

    writePauseState('paused-usage');
    assert.strictEqual(readPauseState(), 'paused-usage');

    writePauseState('running');
    assert.strictEqual(readPauseState(), 'running');
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---- foldPauseEvent / pauseStateOf (the shared reducer the daemon folds live) ----

test('foldPauseEvent: incremental application matches a whole-log foldPauseState', () => {
  // The daemon folds ONE record at a time into pauseAcc; foldPauseState folds a whole list.
  // Both must agree — they share this reducer, so a closed span + an open span match.
  const events = [
    { ts: '2026-07-09T10:00:00.000Z', event: 'Paused', reason: 'manual' },
    { ts: '2026-07-09T10:00:05.000Z', event: 'Resumed', reason: 'manual' },
    { ts: '2026-07-09T11:00:00.000Z', event: 'Paused', reason: 'usage' },
  ];
  const acc = newPauseAcc();
  for (const ev of events) foldPauseEvent(acc, ev);
  assert.deepStrictEqual(pauseStateOf(acc), foldPauseState(events));
  // Concretely: a 5s closed span, then an open 'usage' span.
  const st = pauseStateOf(acc);
  assert.strictEqual(st.paused, true);
  assert.strictEqual(st.reason, 'usage');
  assert.strictEqual(st.pausedSince, '2026-07-09T11:00:00.000Z');
  assert.strictEqual(st.pausedMs, 5000);
});

test('foldPauseEvent: a double Paused keeps the first open span; a stray Resumed is ignored', () => {
  const acc = newPauseAcc();
  foldPauseEvent(acc, { ts: '2026-07-09T10:00:00.000Z', event: 'Resumed' }); // stray -> no-op
  assert.strictEqual(pauseStateOf(acc).paused, false);
  foldPauseEvent(acc, { ts: '2026-07-09T10:00:00.000Z', event: 'Paused', reason: 'manual' });
  foldPauseEvent(acc, { ts: '2026-07-09T10:00:03.000Z', event: 'Paused', reason: 'usage' }); // double -> ignored
  const st = pauseStateOf(acc);
  assert.strictEqual(st.pausedSince, '2026-07-09T10:00:00.000Z');
  assert.strictEqual(st.reason, 'manual');
});

test('pauseStateOf: a fresh accumulator reports not-paused with zero pausedMs', () => {
  assert.deepStrictEqual(pauseStateOf(newPauseAcc()), { paused: false, pausedSince: null, pausedMs: 0, reason: null });
});
