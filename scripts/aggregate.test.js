'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  createState,
  applyEvent,
  snapshot,
  createRollup,
  accumulateTurn,
  accumulateTurnByModel,
  accumulateSession,
} = require('./aggregate');

// Build a normalized event record with sensible defaults; override per case.
function ev(event, over = {}) {
  return {
    ts: '2026-07-02T10:00:00.000Z',
    event,
    session_id: 's1',
    cwd: '/code/acme-api',
    repo_root: '/code/acme-api',
    repo_name: 'acme-api',
    branch: 'main',
    ...over,
  };
}

// Apply a sequence of events to a fresh state and return the one session.
function run(events) {
  const state = createState();
  for (const e of events) applyEvent(state, e);
  return state;
}

// --- session lifecycle -------------------------------------------------------

test('SessionStart registers an idle session with metadata', () => {
  const state = run([
    ev('SessionStart', { source: 'startup', model: 'claude-sonnet-5', owner_pid: 4242, permission_mode: 'default' }),
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.source, 'startup');
  assert.strictEqual(s.model, 'claude-sonnet-5');
  assert.strictEqual(s.ownerPid, 4242);
  assert.strictEqual(s.repoName, 'acme-api');
  assert.strictEqual(s.branch, 'main');
  assert.strictEqual(s.startedAt, '2026-07-02T10:00:00.000Z');
});

test('full turn sequence: prompt -> tool -> stop drives status and promptCount', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Bash' }),
    ev('PostToolUse', { ts: '2026-07-02T10:00:03.000Z', tool_name: 'Bash' }),
    ev('Stop', { ts: '2026-07-02T10:00:04.000Z', stop_reason: 'end_turn' }),
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.status, 'idle'); // Stop returns to idle
  assert.strictEqual(s.promptCount, 1);
  assert.strictEqual(s.currentPrompt, null); // cleared on Stop
  assert.strictEqual(s.currentActivity, null); // cleared on PostToolUse
  assert.strictEqual(s.lastActivityAt, '2026-07-02T10:00:04.000Z');
});

test('UserPromptSubmit sets running with a ticking currentPrompt; PreToolUse sets activity', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Edit' }),
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.status, 'running');
  assert.strictEqual(s.currentActivity, 'Edit');
  assert.deepStrictEqual(s.currentPrompt, { promptId: 'p1', startedAt: '2026-07-02T10:00:01.000Z' });
});

test('missing prompt_id gets a synthetic per-session id', () => {
  const state = run([ev('SessionStart'), ev('UserPromptSubmit')]);
  assert.strictEqual(state.sessions.s1.currentPrompt.promptId, '__prompt_1');
  assert.strictEqual(state.sessions.s1.promptCount, 1);
});

test('two prompts increment promptCount', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('Stop'),
    ev('UserPromptSubmit', { prompt_id: 'p2' }),
  ]);
  assert.strictEqual(state.sessions.s1.promptCount, 2);
  assert.strictEqual(state.sessions.s1.currentPrompt.promptId, 'p2');
});

// --- notifications -----------------------------------------------------------

test('Notification permission_prompt -> waiting', () => {
  const state = run([ev('SessionStart'), ev('Notification', { notification_type: 'permission_prompt' })]);
  assert.strictEqual(state.sessions.s1.status, 'waiting');
});

test('Notification idle_prompt -> idle-waiting', () => {
  const state = run([ev('SessionStart'), ev('Notification', { notification_type: 'idle_prompt' })]);
  assert.strictEqual(state.sessions.s1.status, 'idle-waiting');
});

test('Notification of an unrelated type leaves status unchanged', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }), // running
    ev('Notification', { notification_type: 'auth_success' }),
  ]);
  assert.strictEqual(state.sessions.s1.status, 'running');
});

// --- failure and end ---------------------------------------------------------

test('StopFailure -> error with errorReason; clears the running prompt', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('StopFailure', { stop_reason: 'rate_limit' }),
  ]);
  assert.strictEqual(state.sessions.s1.status, 'error');
  assert.strictEqual(state.sessions.s1.errorReason, 'rate_limit');
  // The turn is over: no live prompt timer keeps ticking on the failed session.
  assert.strictEqual(state.sessions.s1.currentPrompt, null);
  const card = snapshot(state, 0).sessions.find((s) => s.sessionId === 's1');
  assert.strictEqual(card.currentPromptStartedAt, null);
});

test('SessionEnd -> ended with endedReason', () => {
  const state = run([ev('SessionStart'), ev('SessionEnd', { reason: 'logout' })]);
  assert.strictEqual(state.sessions.s1.status, 'ended');
  assert.strictEqual(state.sessions.s1.endedReason, 'logout');
});

// --- subagents ---------------------------------------------------------------

test('Subagent start/stop maintains active/total counters and byType', () => {
  const state = run([
    ev('SessionStart'),
    ev('SubagentStart', { agent_type: 'Explore' }),
    ev('SubagentStart', { agent_type: 'Explore' }),
    ev('SubagentStart', { agent_type: 'Review' }),
    ev('SubagentStop'),
  ]);
  const sub = state.sessions.s1.subagents;
  assert.strictEqual(sub.total, 3);
  assert.strictEqual(sub.active, 2); // 3 started, 1 stopped
  assert.deepStrictEqual(sub.byType, { Explore: 2, Review: 1 });
});

test('SubagentStop never drives active below 0', () => {
  const state = run([ev('SessionStart'), ev('SubagentStop'), ev('SubagentStop')]);
  assert.strictEqual(state.sessions.s1.subagents.active, 0);
});

// --- robustness --------------------------------------------------------------

test('unknown events are ignored but still refresh lastActivityAt/metadata', () => {
  const state = createState();
  applyEvent(state, ev('SessionStart'));
  applyEvent(state, ev('MysteryEvent', { ts: '2026-07-02T10:05:00.000Z', effort_level: 'high' }));
  const s = state.sessions.s1;
  assert.strictEqual(s.status, 'idle'); // unchanged by unknown event
  assert.strictEqual(s.lastActivityAt, '2026-07-02T10:05:00.000Z');
  assert.strictEqual(s.effortLevel, 'high');
});

test('events without a session_id are ignored safely', () => {
  const state = createState();
  applyEvent(state, { event: 'Stop', ts: '2026-07-02T10:00:00.000Z' });
  applyEvent(state, null);
  applyEvent(state, 'garbage');
  assert.deepStrictEqual(state.sessions, {});
});

test('branch:null (detached HEAD) is applied, absent branch is left alone', () => {
  const state = createState();
  applyEvent(state, ev('SessionStart', { branch: 'main' }));
  applyEvent(state, ev('PreToolUse', { branch: null, tool_name: 'Bash' }));
  assert.strictEqual(state.sessions.s1.branch, null);
  // A later event that omits branch entirely must not clobber it.
  applyEvent(state, { event: 'PostToolUse', session_id: 's1', ts: '2026-07-02T10:01:00.000Z' });
  assert.strictEqual(state.sessions.s1.branch, null);
});

// --- snapshot ----------------------------------------------------------------

test('snapshot: waiting sorts first, then running, then others; excludes ended', () => {
  const state = createState();
  // idle session
  applyEvent(state, ev('SessionStart', { session_id: 'idle1', ts: '2026-07-02T10:00:00.000Z' }));
  // running session
  applyEvent(state, ev('SessionStart', { session_id: 'run1' }));
  applyEvent(state, ev('UserPromptSubmit', { session_id: 'run1', prompt_id: 'p', ts: '2026-07-02T10:00:01.000Z' }));
  // waiting session
  applyEvent(state, ev('SessionStart', { session_id: 'wait1' }));
  applyEvent(state, ev('Notification', { session_id: 'wait1', notification_type: 'permission_prompt', ts: '2026-07-02T10:00:02.000Z' }));
  // ended session (must be excluded)
  applyEvent(state, ev('SessionStart', { session_id: 'gone1' }));
  applyEvent(state, ev('SessionEnd', { session_id: 'gone1', reason: 'clear', ts: '2026-07-02T10:00:03.000Z' }));

  const snap = snapshot(state, 1_700_000_000_000);
  assert.strictEqual(snap.now, 1_700_000_000_000);
  const ids = snap.sessions.map((s) => s.sessionId);
  assert.deepStrictEqual(ids, ['wait1', 'run1', 'idle1']); // gone1 excluded, order enforced
});

test('snapshot: same-rank sessions ordered by lastActivityAt desc', () => {
  const state = createState();
  applyEvent(state, ev('SessionStart', { session_id: 'a', ts: '2026-07-02T10:00:00.000Z' }));
  applyEvent(state, ev('SessionStart', { session_id: 'b', ts: '2026-07-02T10:00:05.000Z' }));
  const ids = snapshot(state, Date.now()).sessions.map((s) => s.sessionId);
  assert.deepStrictEqual(ids, ['b', 'a']); // b more recent -> first
});

test('snapshot: card exposes currentPromptStartedAt (ISO or null)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
  ]);
  let card = snapshot(state, Date.now()).sessions[0];
  assert.strictEqual(card.currentPromptStartedAt, '2026-07-02T10:00:01.000Z');
  applyEvent(state, ev('Stop', { ts: '2026-07-02T10:00:02.000Z' }));
  card = snapshot(state, Date.now()).sessions[0];
  assert.strictEqual(card.currentPromptStartedAt, null); // idle again
});

test('snapshot on empty state yields no sessions', () => {
  assert.deepStrictEqual(snapshot(createState(), 5), { now: 5, sessions: [] });
});

// --- rollups -----------------------------------------------------------------

const T = (o = {}) => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...o });

test('accumulateTurn: sums duration, prompts, tokens, and byModel', () => {
  let r = createRollup('2026-07-02');
  r = accumulateTurn(r, {
    repoRoot: '/code/acme-api',
    repoName: 'acme-api',
    model: 'claude-sonnet-5',
    durationMs: 1000,
    tokens: T({ input: 100, output: 50 }),
    ts: '2026-07-02T10:00:00.000Z',
  });
  r = accumulateTurn(r, {
    repoRoot: '/code/acme-api',
    repoName: 'acme-api',
    model: 'claude-opus-4-8',
    durationMs: 2000,
    tokens: T({ input: 10, output: 5, cacheRead: 3, cacheWrite: 7 }),
    ts: '2026-07-02T10:05:00.000Z',
  });
  const repo = r.repos['/code/acme-api'];
  assert.strictEqual(repo.activeMs, 3000);
  assert.strictEqual(repo.prompts, 2);
  assert.deepStrictEqual(repo.tokens, { input: 110, output: 55, cacheRead: 3, cacheWrite: 7 });
  assert.strictEqual(repo.byModel['claude-sonnet-5'].input, 100);
  assert.strictEqual(repo.byModel['claude-opus-4-8'].cacheWrite, 7);
  assert.strictEqual(repo.lastActive, '2026-07-02T10:05:00.000Z'); // latest ts wins
  assert.strictEqual(repo.cost, null); // pricing not done here
});

test('accumulateTurn: tolerates missing tokens/duration (treated as zero)', () => {
  let r = createRollup('2026-07-02');
  r = accumulateTurn(r, { repoRoot: '/r', repoName: 'r', model: 'm', ts: '2026-07-02T10:00:00.000Z' });
  const repo = r.repos['/r'];
  assert.strictEqual(repo.activeMs, 0);
  assert.strictEqual(repo.prompts, 1);
  assert.deepStrictEqual(repo.tokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test('accumulateTurn: no repoRoot is a safe no-op', () => {
  const r = accumulateTurn(createRollup('2026-07-02'), { model: 'm', durationMs: 100 });
  assert.deepStrictEqual(r.repos, {});
});

test('accumulateSession: tracks distinct session ids and lastActive', () => {
  let r = createRollup('2026-07-02');
  r = accumulateSession(r, { repoRoot: '/r', repoName: 'r', sessionId: 's1', ts: '2026-07-02T10:00:00.000Z' });
  r = accumulateSession(r, { repoRoot: '/r', repoName: 'r', sessionId: 's1', ts: '2026-07-02T11:00:00.000Z' }); // dup
  r = accumulateSession(r, { repoRoot: '/r', repoName: 'r', sessionId: 's2', ts: '2026-07-02T09:00:00.000Z' });
  const repo = r.repos['/r'];
  assert.deepStrictEqual(repo.sessions, ['s1', 's2']); // distinct, s1 counted once
  assert.strictEqual(repo.lastActive, '2026-07-02T11:00:00.000Z'); // max ts, not last write
});

test('accumulateTurn then accumulateSession share one repo entry', () => {
  let r = createRollup('2026-07-02');
  r = accumulateTurn(r, { repoRoot: '/r', repoName: 'r', model: 'm', durationMs: 500, tokens: T({ input: 1 }), ts: '2026-07-02T10:00:00.000Z' });
  r = accumulateSession(r, { repoRoot: '/r', repoName: 'r', sessionId: 's1', ts: '2026-07-02T10:00:00.000Z' });
  assert.strictEqual(Object.keys(r.repos).length, 1);
  const repo = r.repos['/r'];
  assert.strictEqual(repo.prompts, 1);
  assert.deepStrictEqual(repo.sessions, ['s1']);
});

test('accumulateTurnByModel: one turn, tokens split per model, counted once', () => {
  const r = accumulateTurnByModel(createRollup('2026-07-02'), {
    repoRoot: '/code/acme-api',
    repoName: 'acme-api',
    durationMs: 1500,
    byModel: {
      'claude-opus-4-8': T({ input: 100, output: 200 }),
      'claude-haiku-4-5': T({ input: 10, output: 5 }), // e.g. a compaction summary
    },
    ts: '2026-07-02T10:00:00.000Z',
  });
  const repo = r.repos['/code/acme-api'];
  assert.strictEqual(repo.prompts, 1); // ONE turn, even though it spans two models
  assert.strictEqual(repo.activeMs, 1500);
  assert.deepStrictEqual(repo.tokens, { input: 110, output: 205, cacheRead: 0, cacheWrite: 0 });
  // Each model keeps its own bucket, so cost can be priced at each model's rate.
  assert.strictEqual(repo.byModel['claude-opus-4-8'].output, 200);
  assert.strictEqual(repo.byModel['claude-haiku-4-5'].input, 10);
});

// --- fixes locked in ---------------------------------------------------------

test('PostToolUse after a permission Notification restores running (not stuck waiting)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('PreToolUse', { tool_name: 'Bash' }),
    ev('Notification', { notification_type: 'permission_prompt' }), // -> waiting
    ev('PostToolUse'), // tool approved & ran -> back to running
  ]);
  assert.strictEqual(state.sessions.s1.status, 'running');
  assert.strictEqual(state.sessions.s1.currentActivity, null);
});

test('PostToolUseFailure is handled like PostToolUse (clears activity, running)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('PreToolUse', { tool_name: 'Bash' }),
    ev('PostToolUseFailure'),
  ]);
  assert.strictEqual(state.sessions.s1.status, 'running');
  assert.strictEqual(state.sessions.s1.currentActivity, null);
});

test('owner_pid is captured from ANY event, not only SessionStart', () => {
  const state = createState();
  // Session first seen via a non-SessionStart event (e.g. after a snapshot loss).
  applyEvent(state, ev('PreToolUse', { owner_pid: 4242, tool_name: 'Bash' }));
  assert.strictEqual(state.sessions.s1.ownerPid, 4242);
});
