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
  accumulateTokensByModel,
  accumulateSession,
  countedSessions,
  accumulateActiveFromEvents,
  accumulateSessionStatsFromEvents,
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

test('waitingSince is a stable anchor: set on entering waiting, unmoved by a benign mid-wait event, cleared on resume', () => {
  const s = run([
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Bash' }),
    ev('Notification', { ts: '2026-07-02T10:00:05.000Z', notification_type: 'permission_prompt' }), // enters waiting
  ]).sessions.s1;
  assert.strictEqual(s.status, 'waiting');
  assert.strictEqual(s.waitingSince, '2026-07-02T10:00:05.000Z');

  // A benign event mid-wait refreshes lastActivityAt but must NOT advance waitingSince,
  // so the card's frozen "paused" figure can't creep.
  const state2 = createState();
  for (const e of [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('Notification', { ts: '2026-07-02T10:00:05.000Z', notification_type: 'permission_prompt' }),
    ev('Notification', { ts: '2026-07-02T10:00:30.000Z', notification_type: 'auth_success' }), // benign, stays waiting
  ]) applyEvent(state2, e);
  const s2 = state2.sessions.s1;
  assert.strictEqual(s2.status, 'waiting');
  assert.strictEqual(s2.lastActivityAt, '2026-07-02T10:00:30.000Z'); // advanced
  assert.strictEqual(s2.waitingSince, '2026-07-02T10:00:05.000Z'); // did NOT advance

  // Approval (PostToolUse -> running) clears the anchor.
  applyEvent(state2, ev('PostToolUse', { ts: '2026-07-02T10:00:40.000Z' }));
  assert.strictEqual(state2.sessions.s1.status, 'running');
  assert.strictEqual(state2.sessions.s1.waitingSince, null);
});

test('Notification idle_prompt after Stop leaves status idle (not a distinct state)', () => {
  // idle_prompt means "done, awaiting your next prompt"; the session is already
  // idle from its Stop, so it stays plain idle rather than "awaiting input".
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('Stop'),
    ev('Notification', { notification_type: 'idle_prompt' }),
  ]);
  assert.strictEqual(state.sessions.s1.status, 'idle');
});

test('Notification idle_prompt mid-turn does not clobber running (background work in flight)', () => {
  // idle_prompt can fire while background work runs and the main loop is quiet; with a
  // background task in flight (bgTasks>0, from Claude Code's registry) it must not idle.
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('PreToolUse', { tool_name: 'Workflow' }),
    ev('Stop', { ts: '2026-07-02T10:00:03.000Z', bg_tasks: 1 }), // handed off; a background task is in flight
    ev('PreToolUse', { tool_name: 'Bash', agent_type: 'workflow-subagent' }), // subagent working -> running
    ev('PostToolUse'), // clears currentActivity but the background task is still in flight
    ev('Notification', { notification_type: 'idle_prompt' }),
  ]);
  assert.strictEqual(state.sessions.s1.status, 'running');
});

test('Notification idle_prompt does not clobber running while a tool is mid-call', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('PreToolUse', { tool_name: 'Bash' }), // in flight, no PostToolUse yet
    ev('Notification', { notification_type: 'idle_prompt' }),
  ]);
  assert.strictEqual(state.sessions.s1.status, 'running');
});

test('Notification idle_prompt settles a running session to idle when nothing is in flight (lost Stop)', () => {
  // If a turn's Stop is somehow missed, idle_prompt with no work in flight is the
  // done-signal that CLOSES the turn: it must not only flip status but clear
  // currentPrompt (else the browser ticks the prompt timer forever) and record
  // the turn's duration.
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Bash' }),
    ev('PostToolUse', { ts: '2026-07-02T10:00:03.000Z' }), // tool done, currentActivity cleared, still 'running'
    ev('Notification', { ts: '2026-07-02T10:00:05.000Z', notification_type: 'idle_prompt' }),
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.currentPrompt, null); // turn closed — no runaway timer
  assert.strictEqual(s.activeMs, 4000); // duration recorded (10:00:01 -> 10:00:05)
  const card = snapshot(state, 0).sessions.find((x) => x.sessionId === 's1');
  assert.strictEqual(card.currentPromptStartedAt, null);
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

// --- per-session active time (engaged clock) ---------------------------------

test('activeMs accumulates each closed turn (Stop and StopFailure)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('Stop', { ts: '2026-07-02T10:00:04.000Z' }), // 3s turn
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:10.000Z', prompt_id: 'p2' }),
    ev('StopFailure', { ts: '2026-07-02T10:00:12.000Z', stop_reason: 'rate_limit' }), // 2s turn
  ]);
  // Sums only working time (3s + 2s), not the 6s idle gap between turns.
  assert.strictEqual(state.sessions.s1.activeMs, 5000);
});

test('activeMs ignores a Stop with no open turn or a non-advancing clock', () => {
  const state = run([
    ev('SessionStart'),
    ev('Stop', { ts: '2026-07-02T10:00:04.000Z' }), // not engaged -> no-op
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:05.000Z', prompt_id: 'p1' }),
    ev('Stop', { ts: '2026-07-02T10:00:05.000Z' }), // same instant -> 0
  ]);
  assert.strictEqual(state.sessions.s1.activeMs, 0);
});

test('activeMs EXCLUDES permission-waiting time within a turn', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Bash' }), // +2s running
    ev('Notification', { ts: '2026-07-02T10:00:03.000Z', notification_type: 'permission_prompt' }), // +1s running, now waiting
    ev('PostToolUse', { ts: '2026-07-02T10:01:03.000Z' }), // 60s WAIT (approval) -> excluded; back to running
    ev('Stop', { ts: '2026-07-02T10:01:05.000Z' }), // +2s running
  ]);
  // Running spans: 0->2, 2->3, (3->63 waiting excluded), 63->65 => 2+1+2 = 5s.
  assert.strictEqual(state.sessions.s1.activeMs, 5000);
});

test('activeMs COUNTS a background workflow running after the turn Stop (bgTasks-driven)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:10.000Z', tool_name: 'Workflow' }), // +10s running (launch)
    ev('Stop', { ts: '2026-07-02T10:00:12.000Z', bg_tasks: 1 }), // +2s; turn closes but a workflow is still in flight
    ev('SubagentStop', { ts: '2026-07-02T10:05:12.000Z', bg_tasks: 0 }), // +5min background (idle but engaged), then all done
  ]);
  const s = state.sessions.s1;
  // 12s in-turn + 300s background = 312s; background_tasks kept the session engaged past Stop.
  assert.strictEqual(s.activeMs, 312000);
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.bgTasks, 0);
  assert.strictEqual(s.disengagedNow, true); // the SubagentStop that emptied bgTasks ended the engaged period
});

test('engagedStartedAt spans the whole engaged period so the card timer keeps counting', () => {
  const state = run([
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:05.000Z', tool_name: 'Workflow' }),
    ev('Stop', { ts: '2026-07-02T10:00:08.000Z', bg_tasks: 1 }), // turn closes; workflow still in flight
  ]);
  const s = state.sessions.s1;
  // Set at the prompt (engaged began) and UNCHANGED across the Stop while background work
  // continues (bgTasks>0), even though the prompt (and its live timer) is gone — timer keeps counting.
  assert.strictEqual(s.engagedStartedAt, '2026-07-02T10:00:01.000Z');
  assert.strictEqual(s.currentPrompt, null);
  // When background work ends (background_tasks empties), it clears (timer stops -> "—").
  applyEvent(state, ev('SubagentStop', { ts: '2026-07-02T10:05:00.000Z', bg_tasks: 0 }));
  assert.strictEqual(s.engagedStartedAt, null);
});

test('engagedStartedAt clears at Stop when no background work is in flight (plain turn)', () => {
  const state = run([
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:01.000Z', prompt_id: 'p1' }),
    ev('Stop', { ts: '2026-07-02T10:00:04.000Z', bg_tasks: 0 }),
  ]);
  assert.strictEqual(state.sessions.s1.engagedStartedAt, null); // no lingering timer on a normal idle
  assert.strictEqual(state.sessions.s1.disengagedNow, true); // a plain turn's Stop ends the engaged period
});

// --- background-task engagement (bgTasks, from Claude Code's background_tasks registry) ------

test('a Stop that handed off to a background workflow stays engaged and does NOT signal finished', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Workflow' }),
    ev('Stop', { ts: '2026-07-02T10:00:05.000Z', bg_tasks: 2 }), // handed off; 2 background tasks still running
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.bgTasks, 2);
  assert.strictEqual(s.disengagedNow, false); // still engaged -> daemon must NOT fire sessionFinished here
  assert.ok(s.engagedStartedAt); // timer keeps counting through the handoff
});

test('a leaked SubagentStart no longer strands the session engaged (bgTasks, not the counter, decides)', () => {
  // The original bug: SubagentStart bumped subagents.active, and a dropped SubagentStop left
  // it stuck > 0, ticking a phantom timer under an Idle badge and folding the idle gap into
  // activeMs. Engagement now reads the authoritative bgTasks, so the stuck counter is inert.
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:01.000Z', agent_type: 'workflow-subagent' }),
    ev('Stop', { ts: '2026-07-02T10:00:05.000Z', bg_tasks: 0 }), // turn truly done; nothing in flight
    // ... the matching SubagentStop never arrives (dropped/interrupted hook) ...
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.subagents.active, 1); // counter is stuck (unreliable) ...
  assert.strictEqual(s.bgTasks, 0); // ... but the registry says nothing is in flight
  assert.strictEqual(s.status, 'idle');
  assert.strictEqual(s.engagedStartedAt, null); // NOT engaged -> no phantom timer
  assert.strictEqual(s.disengagedNow, true); // the Stop ended the engaged period
  // A prompt an hour later must NOT fold the idle gap into activeMs.
  const before = s.activeMs; // 5s (the one real turn)
  applyEvent(state, ev('UserPromptSubmit', { ts: '2026-07-02T11:00:05.000Z', prompt_id: 'p2' }));
  assert.strictEqual(s.activeMs, before);
});

test('an event without background_tasks leaves the last known bgTasks intact', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('Stop', { ts: '2026-07-02T10:00:05.000Z', bg_tasks: 1 }), // background in flight
    ev('PreToolUse', { ts: '2026-07-02T10:00:07.000Z', tool_name: 'Bash', agent_type: 'workflow-subagent' }), // no bg_tasks field
  ]);
  assert.strictEqual(state.sessions.s1.bgTasks, 1); // unchanged by an event that didn't carry the registry
});

test('background completion: the final SubagentStop settles residual running to idle and signals finished', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Workflow' }),
    ev('Stop', { ts: '2026-07-02T10:00:05.000Z', bg_tasks: 1 }), // handoff: idle + engaged
    // the workflow's subagent runs tools on the parent session, setting status back to running:
    ev('PreToolUse', { ts: '2026-07-02T10:00:07.000Z', tool_name: 'Bash', agent_type: 'workflow-subagent' }),
    ev('PostToolUse', { ts: '2026-07-02T10:00:09.000Z' }), // status='running', currentPrompt still null
    ev('SubagentStop', { ts: '2026-07-02T10:00:12.000Z', bg_tasks: 0 }), // all done — but status is still 'running'
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.bgTasks, 0);
  assert.strictEqual(s.status, 'idle'); // residual 'running' settled -> the engaged period actually ends
  assert.strictEqual(s.engagedStartedAt, null); // timer stops at real completion
  assert.strictEqual(s.disengagedNow, true); // "finished" fires HERE, not the premature handoff Stop
  assert.strictEqual(s.activeMs, 12000); // whole engaged period counted (incl. the background gaps)
});

test('a permission prompt disengages but settles to waiting, not idle (daemon must not fire finished)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Bash' }),
    ev('Notification', { ts: '2026-07-02T10:00:03.000Z', notification_type: 'permission_prompt' }),
  ]);
  const s = state.sessions.s1;
  assert.strictEqual(s.status, 'waiting');
  // disengagedNow is true (engaged→not-engaged), so the daemon MUST additionally gate on
  // status==='idle' — otherwise every permission prompt would fire a spurious "session finished".
  assert.strictEqual(s.disengagedNow, true);
});

test('Stop clears currentActivity so no stale "Running <tool>" lingers on an idle/background card', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('PreToolUse', { tool_name: 'Bash' }),
    ev('Stop', { stop_reason: 'end_turn' }),
  ]);
  assert.strictEqual(state.sessions.s1.currentActivity, null);
});

test('activeMs does not double-count a blocking subagent (running AND subagent active)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:01.000Z', agent_type: 'Explore' }),
    ev('SubagentStop', { ts: '2026-07-02T10:00:09.000Z' }), // subagent ran during the turn
    ev('Stop', { ts: '2026-07-02T10:00:10.000Z' }),
  ]);
  // One engaged span 0->10s (running throughout); the overlapping subagent is not added again.
  assert.strictEqual(state.sessions.s1.activeMs, 10000);
});

test('activeMs: a turn-closing event with a bad ts stops the clock (no idle-gap inflation)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Bash' }), // +2s
    ev('Stop', { ts: 'not-a-timestamp' }), // unparseable -> can't settle, but must stop the clock
    ev('UserPromptSubmit', { ts: '2026-07-02T10:30:00.000Z', prompt_id: 'p2' }), // 30min idle gap
    ev('Stop', { ts: '2026-07-02T10:30:05.000Z' }), // +5s
  ]);
  // 2s (first turn, up to the bad Stop) + 5s (second turn); the 30min idle gap is NOT counted.
  assert.strictEqual(state.sessions.s1.activeMs, 7000);
});

test('activeMs: a backward/out-of-order ts does not move the anchor back (no over-count)', () => {
  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:05.000Z', tool_name: 'Bash' }), // anchor -> 10:00:05
    ev('PostToolUse', { ts: '2026-07-02T10:00:04.000Z' }), // earlier ts: no settle, anchor stays 10:00:05
    ev('Stop', { ts: '2026-07-02T10:00:10.000Z' }), // settles 10:00:05 -> 10:00:10 = 5s, not 6s
  ]);
  assert.strictEqual(state.sessions.s1.activeMs, 10000); // 0->5 (5s) + 5->10 (5s) = 10s
});

test('activeMs is safe when a session lacks the clock anchor (older snapshot)', () => {
  // A v0.4.0 snapshot carries activeMs but no engagedSince. The next turn must
  // accrue on top of the restored total without a NaN.
  const state = createState();
  state.sessions.s1 = { sessionId: 's1', status: 'idle', subagents: { active: 0 }, activeMs: 1000, currentPrompt: null };
  applyEvent(state, ev('UserPromptSubmit', { ts: '2026-07-02T10:00:05.000Z', prompt_id: 'p2' }));
  applyEvent(state, ev('Stop', { ts: '2026-07-02T10:00:08.000Z' }));
  assert.strictEqual(state.sessions.s1.activeMs, 4000); // 1000 restored + 3000 new

  // Even with NO activeMs field at all, accrual starts from 0 (num guard), never NaN.
  const st2 = createState();
  st2.sessions.s2 = { sessionId: 's2', status: 'running', subagents: { active: 0 }, currentPrompt: { promptId: 'p', startedAt: '2026-07-02T10:00:00.000Z' } };
  applyEvent(st2, { ts: '2026-07-02T10:00:01.000Z', event: 'PreToolUse', session_id: 's2', tool_name: 'Bash' }); // sets the anchor
  applyEvent(st2, { ts: '2026-07-02T10:00:04.000Z', event: 'Stop', session_id: 's2' }); // settles 3s from 0
  assert.strictEqual(st2.sessions.s2.activeMs, 3000);
  assert.ok(Number.isFinite(st2.sessions.s2.activeMs));
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

// --- tool counts -------------------------------------------------------------

test('toolCount starts at 0 and increments on each PreToolUse (incl. subagent tools)', () => {
  const start = run([ev('SessionStart')]);
  assert.strictEqual(start.sessions.s1.toolCount, 0); // newSession seeds 0

  const state = run([
    ev('SessionStart'),
    ev('UserPromptSubmit', { prompt_id: 'p1' }),
    ev('PreToolUse', { tool_name: 'Bash' }),
    ev('PreToolUse', { tool_name: 'Edit' }),
    ev('PostToolUse'),
    ev('PreToolUse', { tool_name: 'Read' }), // subagent tools fire on the same session_id
  ]);
  assert.strictEqual(state.sessions.s1.toolCount, 3);
});

test('toolCount is safe when a session lacks the counter (older snapshot)', () => {
  // A pre-toolCount snapshot restores a session straight from JSON (no newSession),
  // so toolCount is absent. The num() guard must start it from 0, never NaN.
  const state = createState();
  state.sessions.s1 = { sessionId: 's1', status: 'running', subagents: { active: 0 }, currentPrompt: null };
  applyEvent(state, ev('PreToolUse', { ts: '2026-07-02T10:00:01.000Z', tool_name: 'Bash' }));
  assert.strictEqual(state.sessions.s1.toolCount, 1);
  assert.ok(Number.isFinite(state.sessions.s1.toolCount));
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

test('accumulateTurn: sums prompts, tokens, and byModel (NOT active time)', () => {
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
  assert.strictEqual(repo.activeMs, 0); // active time is event-derived, not from durationMs
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

test('countedSessions: only sessions observed via events AND having spent tokens', () => {
  let r = createRollup('2026-07-02');
  // Three sessions observed via events (repo.sessions).
  for (const sid of ['s-worked', 's-empty', 's-tokens-later']) {
    r = accumulateSession(r, { repoRoot: '/r', repoName: 'r', sessionId: sid, ts: '2026-07-02T10:00:00.000Z' });
  }
  // s-worked spent tokens on a turn; s-empty never did; s-tokens-later spent tokens too.
  r = accumulateTurnByModel(r, { repoRoot: '/r', repoName: 'r', sessionId: 's-worked', byModel: { m: T({ output: 5 }) }, ts: '2026-07-02T10:01:00.000Z' });
  r = accumulateTurnByModel(r, { repoRoot: '/r', repoName: 'r', sessionId: 's-tokens-later', byModel: { m: T({ input: 3 }) }, ts: '2026-07-02T10:02:00.000Z' });
  const repo = r.repos['/r'];
  assert.deepStrictEqual(repo.sessions, ['s-worked', 's-empty', 's-tokens-later']); // all observed
  // s-empty is dropped (0 tokens); order follows repo.sessions.
  assert.deepStrictEqual(countedSessions(repo), ['s-worked', 's-tokens-later']);
});

test('countedSessions: a backfill-only session (tokens but no event) is NOT counted', () => {
  let r = createRollup('2026-07-02');
  // Backfill records carry tokens + a session id but no event ever registered the session.
  r = accumulateTokensByModel(r, { repoRoot: '/r', repoName: 'r', sessionId: 's-backfill', byModel: { m: T({ input: 999 }) }, ts: '2026-07-02T10:00:00.000Z' });
  const repo = r.repos['/r'];
  assert.deepStrictEqual(repo.tokenSessions, ['s-backfill']); // it did spend tokens
  assert.deepStrictEqual(repo.sessions, []); // but no event registered it
  assert.deepStrictEqual(countedSessions(repo), []); // so it doesn't count (unchanged backfill rule)
});

test('countedSessions: a 0-token turn does not mark the session, empty repo -> []', () => {
  let r = createRollup('2026-07-02');
  r = accumulateSession(r, { repoRoot: '/r', repoName: 'r', sessionId: 's1', ts: '2026-07-02T10:00:00.000Z' });
  r = accumulateTurnByModel(r, { repoRoot: '/r', repoName: 'r', sessionId: 's1', byModel: { m: T() }, ts: '2026-07-02T10:01:00.000Z' }); // all-zero
  const repo = r.repos['/r'];
  assert.strictEqual(repo.prompts, 1); // the turn still counts as a chat
  assert.deepStrictEqual(repo.tokenSessions, []); // but it spent nothing
  assert.deepStrictEqual(countedSessions(repo), []);
  assert.deepStrictEqual(countedSessions(undefined), []); // defensive
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
  assert.strictEqual(repo.activeMs, 0); // active time is event-derived, not from durationMs
  assert.deepStrictEqual(repo.tokens, { input: 110, output: 205, cacheRead: 0, cacheWrite: 0 });
  // Each model keeps its own bucket, so cost can be priced at each model's rate.
  assert.strictEqual(repo.byModel['claude-opus-4-8'].output, 200);
  assert.strictEqual(repo.byModel['claude-haiku-4-5'].input, 10);
});

test('accumulateTokensByModel: adds tokens per model WITHOUT counting a turn', () => {
  const r = accumulateTokensByModel(createRollup('2026-07-02'), {
    repoRoot: '/code/acme-api',
    repoName: 'acme-api',
    byModel: { 'claude-opus-4-8': T({ input: 100, output: 50, cacheRead: 20 }) },
    ts: '2026-07-02T09:00:00.000Z',
  });
  const repo = r.repos['/code/acme-api'];
  assert.strictEqual(repo.prompts, 0); // NOT a turn — backfill only
  assert.strictEqual(repo.activeMs, 0); // no duration attributed
  assert.deepStrictEqual(repo.tokens, { input: 100, output: 50, cacheRead: 20, cacheWrite: 0 });
  assert.strictEqual(repo.byModel['claude-opus-4-8'].input, 100);
  assert.strictEqual(repo.lastActive, '2026-07-02T09:00:00.000Z');
});

// --- event-derived per-repo active time --------------------------------------

test('accumulateActiveFromEvents: per-repo active matches the live per-session clock', () => {
  const events = [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('Notification', { ts: '2026-07-02T10:00:05.000Z', notification_type: 'permission_prompt' }), // +5s
    ev('PostToolUse', { ts: '2026-07-02T10:00:35.000Z' }), // 30s wait excluded
    ev('Stop', { ts: '2026-07-02T10:00:40.000Z' }), // +5s
  ];
  // Live per-session clock over the same events:
  const live = run(events).sessions.s1.activeMs;
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  assert.strictEqual(live, 10000); // 5s + 5s, wait excluded
  assert.strictEqual(rollup.repos['/code/acme-api'].activeMs, live); // rollup == live, by construction
});

test('accumulateActiveFromEvents: attributes per repo and per hour-of-day', () => {
  const events = [
    { ts: '2026-07-02T10:00:00.000Z', event: 'UserPromptSubmit', session_id: 'a', repo_root: '/x', repo_name: 'x', prompt_id: 'p1' },
    { ts: '2026-07-02T10:00:04.000Z', event: 'Stop', session_id: 'a', repo_root: '/x', repo_name: 'x' }, // 4s on /x, closes @10:00
    { ts: '2026-07-02T10:00:00.000Z', event: 'UserPromptSubmit', session_id: 'b', repo_root: '/y', repo_name: 'y', prompt_id: 'p1' },
    { ts: '2026-07-02T10:00:10.000Z', event: 'Stop', session_id: 'b', repo_root: '/y', repo_name: 'y' }, // 10s on /y, closes @10:00
  ];
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  assert.strictEqual(rollup.repos['/x'].activeMs, 4000);
  assert.strictEqual(rollup.repos['/y'].activeMs, 10000);
  // Both spans close at 10:xx local time; hourActive buckets them by the closing hour.
  const localHour = new Date(Date.parse('2026-07-02T10:00:04.000Z')).getHours();
  assert.strictEqual(rollup.hourActive[localHour], 14000);
  assert.strictEqual(rollup.hourActive.reduce((a, v) => a + v, 0), 14000); // nothing leaked to other hours
});

test('accumulateActiveFromEvents: a closing event with no prior engaged state contributes nothing', () => {
  // Models the cross-midnight case: day N+1's log holds only the SubagentStop that
  // closes a span opened on day N. A fresh per-day replay has no anchor, so it counts
  // 0 — matching the live path, which resets engagedSince at day rollover. This is the
  // (consistent) boundary under-count, NOT a divergence.
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-03'), [
    { ts: '2026-07-03T00:00:30.000Z', event: 'SubagentStop', session_id: 'a', repo_root: '/x', repo_name: 'x' },
  ]);
  assert.deepStrictEqual(rollup.repos, {});
  assert.strictEqual(rollup.hourActive.reduce((a, v) => a + v, 0), 0);
});

test('accumulateActiveFromEvents: bad input is a safe no-op', () => {
  assert.deepStrictEqual(accumulateActiveFromEvents(createRollup('2026-07-02'), null).repos, {});
  assert.deepStrictEqual(accumulateActiveFromEvents(createRollup('2026-07-02'), 'nope').repos, {});
});

// --- accumulateSessionStatsFromEvents (per-session activeMs + chats/tools/agents) ----

test('accumulateSessionStatsFromEvents: activeMs keyed by session, agrees with the per-repo total', () => {
  const events = [
    { ts: '2026-07-02T10:00:00.000Z', event: 'UserPromptSubmit', session_id: 'a', repo_root: '/x', repo_name: 'x', prompt_id: 'p1' },
    { ts: '2026-07-02T10:00:04.000Z', event: 'Stop', session_id: 'a', repo_root: '/x', repo_name: 'x' }, // 4s
    { ts: '2026-07-02T10:00:00.000Z', event: 'UserPromptSubmit', session_id: 'b', repo_root: '/x', repo_name: 'x', prompt_id: 'p1' },
    { ts: '2026-07-02T10:00:10.000Z', event: 'Stop', session_id: 'b', repo_root: '/x', repo_name: 'x' }, // 10s
  ];
  const perSession = accumulateSessionStatsFromEvents(events);
  assert.strictEqual(perSession.get('a').activeMs, 4000);
  assert.strictEqual(perSession.get('b').activeMs, 10000);
  // By construction, a repo's active time == the sum of its sessions' active time.
  const repo = accumulateActiveFromEvents(createRollup('2026-07-02'), events).repos['/x'].activeMs;
  assert.strictEqual(perSession.get('a').activeMs + perSession.get('b').activeMs, repo);
});

test('accumulateSessionStatsFromEvents: activeMs excludes permission-wait time (same engaged clock)', () => {
  const events = [
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('Notification', { ts: '2026-07-02T10:00:05.000Z', notification_type: 'permission_prompt' }), // +5s engaged
    ev('PostToolUse', { ts: '2026-07-02T10:00:35.000Z' }), // 30s wait excluded
    ev('Stop', { ts: '2026-07-02T10:00:40.000Z' }), // +5s
  ];
  assert.strictEqual(accumulateSessionStatsFromEvents(events).get('s1').activeMs, 10000); // 5s + 5s
});

test('accumulateSessionStatsFromEvents: counts match the live session state (card numbers)', () => {
  const events = [
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:01.000Z', tool_name: 'Bash' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Edit' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:03.000Z', agent_type: 'Explore' }),
    ev('Stop', { ts: '2026-07-02T10:00:04.000Z' }), // 4s engaged
  ];
  const rec = accumulateSessionStatsFromEvents(events).get('s1');
  assert.strictEqual(rec.chats, 1);
  assert.strictEqual(rec.tools, 2);
  assert.strictEqual(rec.agents, 1);
  assert.strictEqual(rec.activeMs, 4000);
  // The counts equal what the live card renders (same counters off the same replay).
  const live = run(events);
  assert.strictEqual(rec.chats, live.sessions.s1.promptCount);
  assert.strictEqual(rec.tools, live.sessions.s1.toolCount);
  assert.strictEqual(rec.agents, live.sessions.s1.subagents.total);
});

test('accumulateSessionStatsFromEvents: observed-but-idle session is present with all-zero counts', () => {
  const rec = accumulateSessionStatsFromEvents([
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
  ]).get('s1');
  assert.deepStrictEqual(rec, { activeMs: 0, chats: 0, tools: 0, agents: 0 });
});

test('accumulateSessionStatsFromEvents: bad input returns an empty Map', () => {
  assert.strictEqual(accumulateSessionStatsFromEvents(null).size, 0);
  assert.strictEqual(accumulateSessionStatsFromEvents(undefined).size, 0);
});

test('accumulateActiveFromEvents: tallies byTool by tool_name, per repo', () => {
  const events = [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:01.000Z', tool_name: 'Bash' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:02.000Z', tool_name: 'Edit' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:03.000Z', tool_name: 'Bash' }),
    ev('Stop', { ts: '2026-07-02T10:00:04.000Z' }),
    // A second repo/session tallies into its own byTool bucket.
    { ts: '2026-07-02T10:00:00.000Z', event: 'UserPromptSubmit', session_id: 'b', repo_root: '/code/other', repo_name: 'other', prompt_id: 'p1' },
    { ts: '2026-07-02T10:00:01.000Z', event: 'PreToolUse', session_id: 'b', repo_root: '/code/other', repo_name: 'other', tool_name: 'Read' },
    { ts: '2026-07-02T10:00:02.000Z', event: 'Stop', session_id: 'b', repo_root: '/code/other', repo_name: 'other' },
  ];
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  assert.deepStrictEqual(rollup.repos['/code/acme-api'].byTool, { Bash: 2, Edit: 1 });
  assert.deepStrictEqual(rollup.repos['/code/other'].byTool, { Read: 1 });
});

test('accumulateActiveFromEvents: tallies per-repo subagent count from SubagentStart', () => {
  const events = [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:01.000Z', agent_type: 'Explore' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:02.000Z', agent_type: 'workflow-subagent' }),
    ev('SubagentStop', { ts: '2026-07-02T10:00:09.000Z' }), // stop does NOT decrement the cumulative count
    ev('Stop', { ts: '2026-07-02T10:00:10.000Z' }),
  ];
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  assert.strictEqual(rollup.repos['/code/acme-api'].subagents, 2); // 2 spawned (stop doesn't reduce it)
});

test('accumulateActiveFromEvents: tallies byAgentType per agent_type, per repo', () => {
  const events = [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:01.000Z', agent_type: 'Explore' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:02.000Z', agent_type: 'Explore' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:03.000Z', agent_type: 'workflow-subagent' }),
    ev('SubagentStop', { ts: '2026-07-02T10:00:09.000Z' }), // stop does NOT decrement the cumulative count
    ev('Stop', { ts: '2026-07-02T10:00:10.000Z' }),
    // A second repo/session tallies into its own byAgentType bucket.
    { ts: '2026-07-02T10:00:00.000Z', event: 'UserPromptSubmit', session_id: 'b', repo_root: '/code/other', repo_name: 'other', prompt_id: 'p1' },
    { ts: '2026-07-02T10:00:01.000Z', event: 'SubagentStart', session_id: 'b', repo_root: '/code/other', repo_name: 'other', agent_type: 'Review' },
    { ts: '2026-07-02T10:00:02.000Z', event: 'Stop', session_id: 'b', repo_root: '/code/other', repo_name: 'other' },
  ];
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  assert.deepStrictEqual(rollup.repos['/code/acme-api'].byAgentType, { Explore: 2, 'workflow-subagent': 1 });
  assert.deepStrictEqual(rollup.repos['/code/other'].byAgentType, { Review: 1 });
});

test('accumulateActiveFromEvents: byAgentType ignores a SubagentStart with no agent_type', () => {
  const events = [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('SubagentStart', { ts: '2026-07-02T10:00:01.000Z' }), // no agent_type -> not tallied
    ev('SubagentStart', { ts: '2026-07-02T10:00:02.000Z', agent_type: 'Explore' }),
    ev('Stop', { ts: '2026-07-02T10:00:10.000Z' }),
  ];
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  // The type-less SubagentStart still bumps the plain subagents count, but not byAgentType.
  assert.strictEqual(rollup.repos['/code/acme-api'].subagents, 2);
  assert.deepStrictEqual(rollup.repos['/code/acme-api'].byAgentType, { Explore: 1 });
});

test('accumulateActiveFromEvents: byAgentType is {} when a repo has no subagents', () => {
  const events = [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('UserPromptSubmit', { ts: '2026-07-02T10:00:00.000Z', prompt_id: 'p1' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:01.000Z', tool_name: 'Bash' }),
    ev('Stop', { ts: '2026-07-02T10:00:04.000Z' }),
  ];
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  assert.deepStrictEqual(rollup.repos['/code/acme-api'].byAgentType, {});
});

test('accumulateActiveFromEvents: byTool counts a PreToolUse even when activeDelta is 0 (unconditional)', () => {
  // A PreToolUse fired from an idle session settles activeDelta === 0 (there was no
  // prior engaged span to close), yet byTool must still count it — the deliberate
  // divergence from the active-time fold, which IS gated on activeDelta > 0. Verify
  // the live clock produces activeDelta 0 for this event, then that byTool counts it.
  const live = run([
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:01.000Z', tool_name: 'Read' }),
  ]);
  assert.strictEqual(live.sessions.s1.activeDelta, 0); // idle -> no span settled

  const events = [
    ev('SessionStart', { ts: '2026-07-02T10:00:00.000Z' }),
    ev('PreToolUse', { ts: '2026-07-02T10:00:01.000Z', tool_name: 'Read' }),
  ];
  const rollup = accumulateActiveFromEvents(createRollup('2026-07-02'), events);
  const repo = rollup.repos['/code/acme-api'];
  assert.deepStrictEqual(repo.byTool, { Read: 1 }); // counted despite activeDelta 0
  assert.strictEqual(repo.activeMs, 0); // ...and no active time was folded
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
