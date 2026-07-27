'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { parseTtyDevice, ttyForPid, focusTty } = require('./focus-terminal');

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
