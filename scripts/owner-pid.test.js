'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseWmicProcesses, walkToOwner, resolveOwnerPid } = require('./owner-pid');

const HEADER = 'Node,CreationDate,Name,ParentProcessId,ProcessId';

// A realistic chain as wmic reports it, newest first:
//   node emit.js (5000) -> powershell.exe (4000) -> claude.exe (3000) -> cmd.exe (2000)
//   -> explorer.exe (1000)
function row(name, pid, ppid, created) {
  return `HOST,${created},${name},${ppid},${pid}`;
}
const CHAIN = [
  HEADER,
  row('node.exe', 5000, 4000, '20260727170500.000000+120'),
  row('powershell.exe', 4000, 3000, '20260727170400.000000+120'),
  row('claude.exe', 3000, 2000, '20260727170300.000000+120'),
  row('cmd.exe', 2000, 1000, '20260727170200.000000+120'),
  row('explorer.exe', 1000, 900, '20260727170100.000000+120'),
].join('\r\n');

// --- parseWmicProcesses -------------------------------------------------------

test('parseWmicProcesses: reads pid, ppid, name and creation date', () => {
  const procs = parseWmicProcesses(CHAIN);
  assert.strictEqual(procs.length, 5);
  assert.deepStrictEqual(procs[0], {
    pid: 5000,
    ppid: 4000,
    name: 'node.exe',
    created: '20260727170500.000000+120',
  });
});

test('parseWmicProcesses: the header and blank lines are skipped', () => {
  assert.deepStrictEqual(parseWmicProcesses(`${HEADER}\r\n\r\n   \r\n`), []);
});

test('parseWmicProcesses: a name containing a comma is read from both ends', () => {
  // pid/ppid are taken from the LAST two fields, so extra commas in Name can't shift them.
  const procs = parseWmicProcesses([HEADER, 'HOST,20260727170500.000000+120,we,ird.exe,4000,5000'].join('\n'));
  assert.deepStrictEqual(procs, [
    { pid: 5000, ppid: 4000, name: 'we,ird.exe', created: '20260727170500.000000+120' },
  ]);
});

test('parseWmicProcesses: malformed rows are skipped, never thrown on', () => {
  const procs = parseWmicProcesses(
    [HEADER, 'too,few', 'HOST,when,bad.exe,4000,notanumber', 'wmic: some warning', row('ok.exe', 7, 1, 'x')].join('\n'),
  );
  assert.deepStrictEqual(procs.map((p) => p.pid), [7]);
});

test('parseWmicProcesses: a non-string is an empty list', () => {
  for (const bad of [null, undefined, 42, {}]) assert.deepStrictEqual(parseWmicProcesses(bad), []);
});

// --- walkToOwner --------------------------------------------------------------

test('walkToOwner: finds claude.exe through the per-hook shell', () => {
  assert.strictEqual(walkToOwner(parseWmicProcesses(CHAIN), 5000, ['claude.exe']), 3000);
});

test('walkToOwner: matches case-insensitively', () => {
  const procs = parseWmicProcesses([HEADER, row('CLAUDE.EXE', 3000, 2000, 'a')].join('\n'));
  assert.strictEqual(walkToOwner(procs, 3000, ['claude.exe']), 3000);
});

test('walkToOwner: stops at the desktop shell rather than walking past it', () => {
  // explorer.exe is every chain's eventual ancestor; continuing through it could only
  // ever produce a wrong answer.
  const procs = parseWmicProcesses(
    [HEADER, row('node.exe', 5000, 1000, 'b'), row('explorer.exe', 1000, 900, 'a')].join('\n'),
  );
  assert.strictEqual(walkToOwner(procs, 5000, ['claude.exe']), null);
});

test('walkToOwner: a recycled parent pid ends the walk instead of being trusted', () => {
  // The "parent" was created AFTER its child, so the pid was reused — the real parent
  // is gone and anything above this point is a different process tree.
  const procs = parseWmicProcesses(
    [
      HEADER,
      row('node.exe', 5000, 4000, '20260727170500.000000+120'),
      row('powershell.exe', 4000, 3000, '20260727170900.000000+120'), // later than its child
      row('claude.exe', 3000, 2000, '20260727170300.000000+120'),
    ].join('\n'),
  );
  assert.strictEqual(walkToOwner(procs, 5000, ['claude.exe']), null);
});

test('walkToOwner: a missing creation date just skips the reuse check', () => {
  const procs = parseWmicProcesses(
    [HEADER, 'HOST,,node.exe,3000,5000', 'HOST,,claude.exe,2000,3000'].join('\n'),
  );
  assert.strictEqual(walkToOwner(procs, 5000, ['claude.exe']), 3000);
});

test('walkToOwner: an unknown start pid or broken chain is null, not a throw', () => {
  const procs = parseWmicProcesses(CHAIN);
  assert.strictEqual(walkToOwner(procs, 99999, ['claude.exe']), null);
  assert.strictEqual(walkToOwner(procs, 0, ['claude.exe']), null);
  assert.strictEqual(walkToOwner(null, 5000, ['claude.exe']), null);
});

test('walkToOwner: a parent cycle terminates', () => {
  const procs = parseWmicProcesses(
    [HEADER, row('a.exe', 10, 11, 'a'), row('b.exe', 11, 10, 'a')].join('\n'),
  );
  assert.strictEqual(walkToOwner(procs, 10, ['claude.exe']), null);
});

// --- resolveOwnerPid ----------------------------------------------------------

test('resolveOwnerPid: no-ops off Windows', async (t) => {
  if (process.platform === 'win32') return t.skip('Windows resolves for real here');
  assert.strictEqual(await resolveOwnerPid(process.ppid), null);
});

test('resolveOwnerPid: a bogus start pid is null without spawning anything', async () => {
  for (const bad of ['123; calc.exe', null, 0, -1]) {
    assert.strictEqual(await resolveOwnerPid(bad), null, String(bad));
  }
});

test('resolveOwnerPid: honours ONE deadline across both stages', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  // The two stages must share a budget: spending it twice would overrun ensure.js's
  // exit guard, stalling SessionStart AND still recording nothing.
  const budget = 1200;
  const t0 = Date.now();
  await resolveOwnerPid(process.ppid, budget);
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < budget * 1.8, `took ${elapsed}ms against a ${budget}ms budget`);
});

test('resolveOwnerPid: finds this process tree\'s owner on Windows, or honestly nothing', async (t) => {
  if (process.platform !== 'win32') return t.skip('Windows only');
  const pid = await resolveOwnerPid(process.ppid, 5000);
  // Under a Claude Code hook this is claude.exe; run standalone there may be no such
  // ancestor. Either is correct — what must never happen is a bogus value.
  assert.ok(pid === null || (Number.isInteger(pid) && pid > 0), `got ${pid}`);
});
