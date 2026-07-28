'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  MAX_ANCESTORS,
  WINDOWLESS_ANCESTORS,
  ancestorWalkScript,
  parsePidOutput,
  runPowerShell,
} = require('./winproc');

// --- parsePidOutput -----------------------------------------------------------

test('parsePidOutput: reads a resolved pid', () => {
  assert.strictEqual(parsePidOutput('pid=4242\n'), 4242);
});

test('parsePidOutput: `none` and junk are null', () => {
  for (const bad of ['none\n', '', '   ', 'pid=', 'pid=abc', null, undefined, 42]) {
    assert.strictEqual(parsePidOutput(bad), null, String(bad));
  }
});

test('parsePidOutput: a pid with anything appended is rejected, not truncated', () => {
  // Defence in depth — the value is re-validated before it reaches PowerShell again,
  // but a strict shape check stops junk travelling that far at all.
  assert.strictEqual(parsePidOutput('pid=4242; calc.exe\n'), null);
  assert.strictEqual(parsePidOutput('pid=$(whoami)\n'), null);
});

test('parsePidOutput: pid 0 is not a pid', () => {
  assert.strictEqual(parsePidOutput('pid=0\n'), null);
});

// --- ancestorWalkScript -------------------------------------------------------

test('ancestorWalkScript: refuses a non-integer pid instead of interpolating it', () => {
  // The ONLY caller-supplied value that reaches PowerShell is this pid, so its
  // validation is the whole injection boundary.
  for (const bad of ['123; calc.exe', null, undefined, 0, -1, 1.5, '4242']) {
    assert.throws(() => ancestorWalkScript(bad), TypeError, String(bad));
  }
});

test('ancestorWalkScript: window-owner mode tests MainWindowHandle', () => {
  const s = ancestorWalkScript(4242);
  assert.match(s, /\$id = 4242/);
  assert.match(s, /MainWindowHandle -ne 0/);
  assert.doesNotMatch(s, /\$match -contains/);
});

test('ancestorWalkScript: match mode tests image names and never probes windows', () => {
  const s = ancestorWalkScript(4242, { matchNames: ['claude.exe'] });
  assert.match(s, /\$match = @\('claude\.exe'\)/);
  assert.match(s, /\$match -contains \$ci\.Name/);
  assert.doesNotMatch(s, /MainWindowHandle/);
});

test('ancestorWalkScript: always guards pid reuse via CreationDate', () => {
  // Win32_Process keeps reporting a ParentProcessId after the parent exits, so
  // without this a recycled pid could pass as a live ancestor.
  for (const opts of [undefined, { matchNames: ['claude.exe'] }]) {
    assert.match(ancestorWalkScript(4242, opts), /\$ci\.CreationDate -gt \$prev/);
  }
});

test('ancestorWalkScript: stops at the desktop shell by default', () => {
  const s = ancestorWalkScript(4242);
  assert.ok(WINDOWLESS_ANCESTORS.includes('explorer.exe'));
  for (const name of WINDOWLESS_ANCESTORS) assert.ok(s.includes(`'${name}'`), name);
  assert.match(s, /\$stop -contains \$ci\.Name/);
});

test('ancestorWalkScript: the walk is bounded', () => {
  assert.match(ancestorWalkScript(4242), new RegExp(`\\$i -lt ${MAX_ANCESTORS}`));
  assert.match(ancestorWalkScript(4242, { maxDepth: 3 }), /\$i -lt 3/);
});

// --- runPowerShell ------------------------------------------------------------

test('runPowerShell: a missing powershell.exe resolves null rather than rejecting', async (t) => {
  if (process.platform === 'win32') return t.skip('powershell.exe exists here');
  // Every caller treats null as "couldn't tell" and degrades to an honest absence,
  // so the spawn-failure path must never reject.
  assert.strictEqual(await runPowerShell('exit 0', 1000), null);
});

test('runPowerShell: round-trips a script on Windows', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const out = await runPowerShell("Write-Output 'pid=7'", 15000);
  assert.strictEqual(parsePidOutput(out), 7);
});
