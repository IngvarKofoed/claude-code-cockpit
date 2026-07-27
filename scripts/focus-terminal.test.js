'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  parseTtyDevice,
  parseWindowPid,
  ttyForPid,
  windowPidForPid,
  focusTty,
  focusWindowPid,
  resolveFocusTarget,
  focusTarget,
} = require('./focus-terminal');

// --- parseTtyDevice (pure `ps -o tty=` output parser) -------------------------

test('parseTtyDevice: a real terminal becomes its /dev path', () => {
  assert.strictEqual(parseTtyDevice('ttys004\n'), '/dev/ttys004');
});

test('parseTtyDevice: trailing whitespace from ps is tolerated', () => {
  // `ps -o tty= -p <pid>` pads its column — real observed output.
  assert.strictEqual(parseTtyDevice('ttys004 \n'), '/dev/ttys004');
});

test('parseTtyDevice: "??" (no controlling terminal) -> null', () => {
  // What a daemon or launchd agent reports — these sessions can never be focused.
  assert.strictEqual(parseTtyDevice('??\n'), null);
});

test('parseTtyDevice: empty / whitespace-only output -> null', () => {
  assert.strictEqual(parseTtyDevice(''), null);
  assert.strictEqual(parseTtyDevice('   \n'), null);
});

test('parseTtyDevice: output that is not a tty name -> null', () => {
  assert.strictEqual(parseTtyDevice('not a tty\n'), null);
});

test('parseTtyDevice: shell metacharacters are rejected, not passed through', () => {
  // Defence in depth: the value reaches osascript via argv (never a shell), but a
  // strict shape check means junk can't travel that far in the first place.
  assert.strictEqual(parseTtyDevice('ttys004; rm -rf /\n'), null);
  assert.strictEqual(parseTtyDevice('$(whoami)\n'), null);
});

test('parseTtyDevice: reads only the first line', () => {
  assert.strictEqual(parseTtyDevice('ttys004\nttys009\n'), '/dev/ttys004');
});

// --- ttyForPid (real `ps`, no mocks) -----------------------------------------

test('ttyForPid: a process with no controlling terminal resolves to null', async () => {
  // The test runner itself is not attached to a tty, so this exercises the real
  // `??` path end-to-end through an actual ps spawn.
  assert.strictEqual(await ttyForPid(process.pid), null);
});

test('ttyForPid: a pid that does not exist resolves to null', async () => {
  assert.strictEqual(await ttyForPid(0x7ffffff), null);
});

test('ttyForPid: a non-numeric pid resolves to null without spawning', async () => {
  assert.strictEqual(await ttyForPid('123; echo hi'), null);
  assert.strictEqual(await ttyForPid(null), null);
});

// --- focusTty (guards; the AppleScript itself is verified manually) ----------

test('focusTty: a malformed tty is refused before anything is spawned', async () => {
  const r = await focusTty('bogus');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid-tty');
});

// --- parseWindowPid (pure ancestor-walk output parser) -----------------------

test('parseWindowPid: a window owner becomes its pid', () => {
  assert.strictEqual(parseWindowPid('pid=4242\n'), 4242);
});

test('parseWindowPid: trailing whitespace is tolerated', () => {
  assert.strictEqual(parseWindowPid('pid=4242 \r\n'), 4242);
});

test('parseWindowPid: "none" (no ancestor owns a window) -> null', () => {
  // A Windows service or any windowless host — these sessions can never be focused.
  assert.strictEqual(parseWindowPid('none\n'), null);
});

test('parseWindowPid: empty / non-matching output -> null', () => {
  assert.strictEqual(parseWindowPid(''), null);
  assert.strictEqual(parseWindowPid('   \n'), null);
  assert.strictEqual(parseWindowPid('Get-CimInstance : Access denied\n'), null);
});

test('parseWindowPid: pid 0 (the idle process) -> null', () => {
  assert.strictEqual(parseWindowPid('pid=0\n'), null);
});

test('parseWindowPid: a pid with anything appended is rejected, not truncated', () => {
  // Defence in depth: the value is re-validated before it reaches PowerShell, but a
  // strict shape check means junk can't travel that far in the first place.
  assert.strictEqual(parseWindowPid('pid=4242; calc.exe\n'), null);
  assert.strictEqual(parseWindowPid('pid=$(whoami)\n'), null);
});

test('parseWindowPid: reads only the first line', () => {
  assert.strictEqual(parseWindowPid('pid=4242\npid=9\n'), 4242);
});

// --- windowPidForPid / focusWindowPid (guards; PowerShell verified on Windows) ---

test('windowPidForPid: a non-numeric pid resolves to null without spawning', async () => {
  assert.strictEqual(await windowPidForPid('123; calc.exe'), null);
  assert.strictEqual(await windowPidForPid(null), null);
  assert.strictEqual(await windowPidForPid(0), null);
});

test('windowPidForPid: no powershell.exe on this platform resolves to null', async (t) => {
  if (process.platform === 'win32') return t.skip('powershell.exe exists here');
  // Exercises the real spawn-failure path: a missing binary is just "no window".
  assert.strictEqual(await windowPidForPid(process.pid), null);
});

test('focusWindowPid: an invalid pid is refused before anything is spawned', async () => {
  const r = await focusWindowPid(0);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'invalid-target');
});

// --- resolveFocusTarget / focusTarget (platform routing) ---------------------

test('resolveFocusTarget: a bogus pid resolves to null on every platform', async () => {
  assert.strictEqual(await resolveFocusTarget('123; calc.exe'), null);
  assert.strictEqual(await resolveFocusTarget(null), null);
});

test('focusTarget: a target of no known shape is refused', async () => {
  for (const bad of ['bogus', '', null, undefined, 42, 'pid:', 'pid:4242; calc.exe']) {
    const r = await focusTarget(bad);
    assert.strictEqual(r.ok, false, String(bad));
    assert.strictEqual(r.reason, 'invalid-target', String(bad));
  }
});

test('focusTarget: routes on the target SHAPE, not the running platform', async () => {
  // A snapshot carried between machines must not hand a tty to the Windows path (or a
  // window pid to osascript) — the off-platform branch reports unsupported-platform,
  // which also proves the routing without raising a real window on the dev machine.
  const foreign = process.platform === 'darwin' ? 'pid:4242' : '/dev/ttys004';
  const r = await focusTarget(foreign);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, 'unsupported-platform');
});
