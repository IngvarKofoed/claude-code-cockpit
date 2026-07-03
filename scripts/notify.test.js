'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { buildNotification } = require('./notify');

// A full-ish config with everything enabled; individual tests override.
function cfg(overrides) {
  return Object.assign(
    {
      osNotifications: true,
      sound: true,
      events: {
        sessionFinished: true,
        needsInput: true,
        longRunning: true,
        turnFailed: true,
      },
    },
    overrides
  );
}

const session = { repoName: 'acme-api', errorReason: 'rate_limit' };

const ALL_EVENTS = ['sessionFinished', 'needsInput', 'longRunning', 'turnFailed'];

test('returns null when the master toggle is off', () => {
  for (const ev of ALL_EVENTS) {
    assert.strictEqual(
      buildNotification(ev, session, cfg({ osNotifications: false })),
      null
    );
  }
});

test('returns null when the per-event toggle is off', () => {
  for (const ev of ALL_EVENTS) {
    const config = cfg();
    config.events[ev] = false;
    assert.strictEqual(buildNotification(ev, session, config), null);
  }
});

test('returns null for missing/empty config', () => {
  assert.strictEqual(buildNotification('needsInput', session, null), null);
  assert.strictEqual(buildNotification('needsInput', session, {}), null);
});

test('returns null for an unknown event name', () => {
  assert.strictEqual(buildNotification('somethingElse', session, cfg()), null);
});

test('builds a notification for each enabled event', () => {
  for (const ev of ALL_EVENTS) {
    const n = buildNotification(ev, session, cfg());
    assert.ok(n, `expected a notification for ${ev}`);
    assert.strictEqual(n.event, ev);
    // Title always carries the repo name.
    assert.ok(n.title.startsWith('acme-api — '), `title was "${n.title}"`);
    assert.strictEqual(typeof n.message, 'string');
    assert.ok(n.message.length > 0);
  }
});

test('sound is taken from config.sound (pass-through)', () => {
  assert.strictEqual(buildNotification('needsInput', session, cfg()).sound, true);
  assert.strictEqual(
    buildNotification('needsInput', session, cfg({ sound: false })).sound,
    false
  );
  assert.strictEqual(
    buildNotification('needsInput', session, cfg({ sound: 'Bottle' })).sound,
    'Bottle'
  );
});

test('per-event titles reflect the event', () => {
  const titles = {
    sessionFinished: 'acme-api — finished',
    needsInput: 'acme-api — needs input',
    longRunning: 'acme-api — running long',
    turnFailed: 'acme-api — turn failed',
  };
  for (const ev of ALL_EVENTS) {
    assert.strictEqual(buildNotification(ev, session, cfg()).title, titles[ev]);
  }
});

test('turnFailed includes the error reason when present, generic otherwise', () => {
  const withReason = buildNotification('turnFailed', session, cfg());
  assert.ok(withReason.message.includes('rate_limit'));

  const noReason = buildNotification('turnFailed', { repoName: 'acme-api' }, cfg());
  assert.ok(!/rate_limit/.test(noReason.message));
  assert.ok(noReason.message.length > 0);
});

test('falls back to "unknown repo" when the session has no repoName', () => {
  const n = buildNotification('needsInput', {}, cfg());
  assert.ok(n.title.startsWith('unknown repo — '));
});
