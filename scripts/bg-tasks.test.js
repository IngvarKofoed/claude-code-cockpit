'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isTaskId, bgLaunchId, looksLikeTestRun } = require('./bg-tasks');

test('looksLikeTestRun: test runners and e2e scripts count', () => {
  for (const cmd of [
    'npm test',
    'npm run e2e -- --workers=1 > /private/tmp/x/scratchpad/e2e.log 2>&1',
    'cd /Users/me/magic-grow && npx playwright test --workers=1 2>&1 | tail -40',
    'npx playwright test e2e/distillery.spec.ts --workers=1',
    'cd src/frontend/Flux.Web && npx vitest run 2>&1 | tail -40',
    'cd src/backend && dotnet test Flux.Tests --no-build',
    'pytest tests/ -q',
    'go test ./...',
    'cargo test',
    'node --test scripts/',
    'pnpm -r test',
    'npm run test:unit',
    'npm run e2e:headless',
    'rm -rf test-results && npx playwright test --last-failed',
  ]) {
    assert.strictEqual(looksLikeTestRun(cmd), true, cmd);
  }
});

test('looksLikeTestRun: servers whose PATHS, FILE NAMES or ENV mention e2e/test do not', () => {
  // Each of these is a real long-lived server command that the naive substring test matched.
  for (const cmd of [
    'E2E_PORT=6100 node release/server.js',
    'cd /Users/me/flux && NODE_PATH=src/e2e/Flux.E2E.Tests/node_modules node run-unit.js',
    'npm run dev -- --port 5199 --strictPort > temp/ivory-test/dev.log 2>&1',
    'dotnet run --project src/e2e/Flux.E2E.Tests/Host.csproj',
    'tail -n +1 -f /private/tmp/x/scratchpad/e2e.log | grep -E --line-buffered "passed|failed"',
  ]) {
    assert.strictEqual(looksLikeTestRun(cmd), false, cmd);
  }
});

test('looksLikeTestRun: quoted strings are arguments, not commands', () => {
  assert.strictEqual(
    looksLikeTestRun(`sqlite3 data/app.db "update users set password='RallyTest!2026' where name='test'"; npm run dev`),
    false
  );
  assert.strictEqual(looksLikeTestRun(`until grep -qE "Tests " /tmp/out.txt; do sleep 5; done`), false);
  assert.strictEqual(looksLikeTestRun(`echo "a \\"quoted\\" test" && npm run dev`), false);
});

test('looksLikeTestRun: a watch-mode run never exits, so it never counts', () => {
  assert.strictEqual(looksLikeTestRun('npx vitest --watch'), false);
  assert.strictEqual(looksLikeTestRun('npm run test:watch'), false);
  assert.strictEqual(looksLikeTestRun('jest --watchAll'), false);
  // an explicit opt-out is a one-shot run
  assert.strictEqual(looksLikeTestRun('CI=true npm test -- --watchAll=false'), true);
  assert.strictEqual(looksLikeTestRun('npx vitest --watch=false'), true);
});

test('looksLikeTestRun: a `latest` version tag is not a test word', () => {
  assert.strictEqual(looksLikeTestRun('npx serve@latest -l 5000'), false);
  assert.strictEqual(looksLikeTestRun('docker run --rm -p 5432:5432 postgres:latest'), false);
  assert.strictEqual(looksLikeTestRun('npx playwright@latest test'), true);
});

test('looksLikeTestRun: tolerates absent / non-string commands', () => {
  for (const v of [undefined, null, '', 42, {}]) assert.strictEqual(looksLikeTestRun(v), false);
});

test('isTaskId accepts opaque ids only', () => {
  assert.strictEqual(isTaskId('bjtg3c5e2'), true);
  assert.strictEqual(isTaskId('has spaces; free text'), false);
  assert.strictEqual(isTaskId('x'.repeat(65)), false);
  assert.strictEqual(isTaskId(7), false);
});

test('bgLaunchId reads Bash backgroundTaskId and non-persistent Monitor taskId', () => {
  const post = (tool_name, tool_response) => ({ hook_event_name: 'PostToolUse', tool_name, tool_response });
  assert.strictEqual(bgLaunchId(post('Bash', { stdout: '', backgroundTaskId: 'bjtg3c5e2' })), 'bjtg3c5e2');
  assert.strictEqual(bgLaunchId(post('Monitor', { taskId: 'bpi27lqcg', timeoutMs: 60000 })), 'bpi27lqcg');
  assert.strictEqual(bgLaunchId(post('Monitor', { taskId: 'bpi27lqcg', persistent: true })), null);
  assert.strictEqual(bgLaunchId(post('Bash', { stdout: 'ok' })), null); // a foreground command
  assert.strictEqual(bgLaunchId(post('Bash', { backgroundTaskId: 'not an id!' })), null);
  assert.strictEqual(bgLaunchId({ hook_event_name: 'PreToolUse', tool_response: { backgroundTaskId: 'b1' } }), null);
  assert.strictEqual(bgLaunchId(undefined), null);
});
