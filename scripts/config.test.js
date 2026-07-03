'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { DEFAULT_CONFIG, readConfig, writeConfig, validateConfig, mergeConfig } = require('./config');

// ---- mergeConfig -------------------------------------------------------

test('mergeConfig: nested objects merge, scalars replace, absent keys kept', () => {
  const base = { a: 1, nested: { x: 1, y: 2 }, keep: 'me' };
  const merged = mergeConfig(base, { a: 9, nested: { y: 20, z: 30 } });
  assert.deepStrictEqual(merged, { a: 9, nested: { x: 1, y: 20, z: 30 }, keep: 'me' });
});

test('mergeConfig: arrays are replaced, not merged', () => {
  const merged = mergeConfig({ list: [1, 2, 3] }, { list: [9] });
  assert.deepStrictEqual(merged.list, [9]);
});

test('mergeConfig: does not mutate the base object', () => {
  const base = { nested: { x: 1 } };
  mergeConfig(base, { nested: { x: 99 } });
  assert.strictEqual(base.nested.x, 1);
});

// ---- validateConfig ----------------------------------------------------

test('validateConfig: empty input -> defaults, valid', () => {
  const res = validateConfig({});
  assert.strictEqual(res.valid, true);
  assert.deepStrictEqual(res.errors, []);
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
});

test('validateConfig: partial override merges over defaults', () => {
  const res = validateConfig({ port: 5000, events: { longRunning: true } });
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.config.port, 5000);
  assert.strictEqual(res.config.events.longRunning, true);
  // Untouched defaults survive.
  assert.strictEqual(res.config.events.sessionFinished, true);
  assert.strictEqual(res.config.osNotifications, true);
});

test('validateConfig: rejects bad types', () => {
  const res = validateConfig({ port: 'not-a-number', osNotifications: 'yes', activityDetail: 'nope' });
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('port')));
  assert.ok(res.errors.some((e) => e.includes('osNotifications')));
  assert.ok(res.errors.some((e) => e.includes('activityDetail')));
  // Bad values fall back to defaults so the config stays complete.
  assert.strictEqual(res.config.port, DEFAULT_CONFIG.port);
  assert.strictEqual(res.config.activityDetail, 'tool');
});

test('validateConfig: non-object input -> invalid, defaults returned', () => {
  const res = validateConfig(null);
  assert.strictEqual(res.valid, false);
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
});

test('validateConfig: clamps negatives to 0 (still valid)', () => {
  const res = validateConfig({ longRunningThresholdMs: -1000, retentionDays: -5, idleShutdownHours: -2 });
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.config.longRunningThresholdMs, 0);
  assert.strictEqual(res.config.retentionDays, 0);
  assert.strictEqual(res.config.idleShutdownHours, 0);
});

test('validateConfig: coerces safe types (numeric strings, "true"/"false")', () => {
  const res = validateConfig({ port: '8080', sound: 'false', retentionDays: '30' });
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.config.port, 8080);
  assert.strictEqual(res.config.sound, false);
  assert.strictEqual(res.config.retentionDays, 30);
});

test('validateConfig: a provided rates map is authoritative — it replaces defaults', () => {
  const res = validateConfig({
    cost: { rates: { 'my-model': { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 } } },
  });
  assert.strictEqual(res.valid, true);
  assert.deepStrictEqual(res.config.cost.rates['my-model'], { input: 2, output: 4, cacheRead: 0.2, cacheWrite: 2.5 });
  // A model omitted from the provided map is removed — the Settings UI can delete
  // a default rate and have it stay deleted.
  assert.strictEqual(res.config.cost.rates['claude-sonnet-5'], undefined);
});

test('validateConfig: no rates key -> default rates preserved', () => {
  const res = validateConfig({ cost: { currency: 'EUR' } });
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.config.cost.currency, 'EUR');
  assert.ok(res.config.cost.rates['claude-sonnet-5']); // untouched defaults survive
});

test('validateConfig: incomplete rate entry -> error; invalid model dropped, valid siblings kept', () => {
  const res = validateConfig({
    cost: {
      rates: {
        'claude-sonnet-5': { input: 9 }, // missing output/cacheRead/cacheWrite
        'ok-model': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 },
      },
    },
  });
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('claude-sonnet-5')));
  // The invalid entry is dropped (renders as unpriced); valid siblings survive.
  assert.strictEqual(res.config.cost.rates['claude-sonnet-5'], undefined);
  assert.deepStrictEqual(res.config.cost.rates['ok-model'], { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 });
});

test('validateConfig: events non-boolean rejected', () => {
  const res = validateConfig({ events: { needsInput: 'maybe' } });
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('events.needsInput')));
});

// ---- DEFAULT_CONFIG immutability --------------------------------------

test('DEFAULT_CONFIG is frozen and not mutated by validateConfig', () => {
  assert.ok(Object.isFrozen(DEFAULT_CONFIG));
  const res = validateConfig({ port: 1 });
  res.config.port = 99999;
  res.config.events.needsInput = false;
  assert.strictEqual(DEFAULT_CONFIG.port, 4319);
  assert.strictEqual(DEFAULT_CONFIG.events.needsInput, true);
});

// ---- read / write round-trip (redirects dirs to a temp dir) -----------

test('readConfig/writeConfig: round-trip through a temp dir', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-cfg-'));
  // paths.js reads these env vars lazily on every call, so overriding them
  // here keeps the test off the real config/state dirs. Cover posix + win.
  const envKeys = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE'];
  const saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  try {
    process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
    process.env.XDG_STATE_HOME = path.join(tmp, 'state');
    process.env.APPDATA = path.join(tmp, 'appdata');
    process.env.LOCALAPPDATA = path.join(tmp, 'localappdata');
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;

    // No file yet -> defaults.
    assert.deepStrictEqual(readConfig(), DEFAULT_CONFIG);

    const wrote = writeConfig({ port: 5555, events: { longRunning: true } });
    assert.strictEqual(wrote.ok, true);
    assert.strictEqual(wrote.config.port, 5555);

    const read = readConfig();
    assert.strictEqual(read.port, 5555);
    assert.strictEqual(read.events.longRunning, true);
    assert.strictEqual(read.retentionDays, DEFAULT_CONFIG.retentionDays); // defaults filled

    // Invalid write is rejected and leaves disk untouched.
    const bad = writeConfig({ port: 'nope' });
    assert.strictEqual(bad.ok, false);
    assert.ok(Array.isArray(bad.errors));
    assert.strictEqual(readConfig().port, 5555);
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('readConfig: malformed json file -> defaults (never throws)', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-cfg-'));
  const envKeys = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE'];
  const saved = {};
  for (const k of envKeys) saved[k] = process.env[k];
  try {
    process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
    process.env.XDG_STATE_HOME = path.join(tmp, 'state');
    process.env.APPDATA = path.join(tmp, 'appdata');
    process.env.LOCALAPPDATA = path.join(tmp, 'localappdata');
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;

    const cfgDir = path.join(tmp, 'config', 'claude-code-cockpit');
    fs.mkdirSync(cfgDir, { recursive: true });
    fs.writeFileSync(path.join(cfgDir, 'config.json'), '{ this is not json ');
    assert.deepStrictEqual(readConfig(), DEFAULT_CONFIG);
  } finally {
    for (const k of envKeys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
