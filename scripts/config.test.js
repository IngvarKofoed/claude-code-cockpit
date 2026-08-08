'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const paths = require('./paths');

const {
  DEFAULT_CONFIG,
  CONFIG_VERSION,
  readConfig,
  writeConfig,
  validateConfig,
  migrateRawConfig,
  mergeConfig,
} = require('./config');

const OLD_OPUS_48 = { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 };
const NEW_OPUS_48 = DEFAULT_CONFIG.cost.rates['claude-opus-4-8'];

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

test('validateConfig: usagePace accepts the enum values, defaults to "both"', () => {
  assert.strictEqual(DEFAULT_CONFIG.usagePace, 'both');
  for (const v of ['both', 'tick', 'delta', 'off']) {
    const res = validateConfig({ usagePace: v });
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.config.usagePace, v);
  }
});

test('validateConfig: invalid usagePace rejected, falls back to default', () => {
  const res = validateConfig({ usagePace: 'nope' });
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('usagePace')));
  // Bad value falls back to the default so the config stays complete.
  assert.strictEqual(res.config.usagePace, 'both');
});

// The trend arrow's spans are hardcoded (usage.js:TREND_SPAN_MS), so the retired
// usageWeeklyLookbackHours key is no longer part of the schema. A persisted one falls out as
// an unknown key — asserted here so a re-added validation branch has to be deliberate.
test('validateConfig: the retired usageWeeklyLookbackHours key is dropped, not rejected', () => {
  assert.strictEqual('usageWeeklyLookbackHours' in DEFAULT_CONFIG, false);
  const res = validateConfig({ usageWeeklyLookbackHours: 6 });
  assert.strictEqual(res.valid, true);
  assert.strictEqual('usageWeeklyLookbackHours' in res.config, false);
});

test('validateConfig: subscriptionLabelPattern defaults to the parenthesized-group regex', () => {
  assert.strictEqual(DEFAULT_CONFIG.subscriptionLabelPattern, '\\(([^)]+)\\)');
  // The default compiles and extracts the parenthesized part.
  const re = new RegExp(DEFAULT_CONFIG.subscriptionLabelPattern);
  assert.strictEqual(re.exec('FOSS Analytical (Lyra)')[1], 'Lyra');
});

test('validateConfig: accepts a valid regex pattern and "" (extraction off)', () => {
  const ok = validateConfig({ subscriptionLabelPattern: '\\[(.+?)\\]' });
  assert.strictEqual(ok.valid, true);
  assert.strictEqual(ok.config.subscriptionLabelPattern, '\\[(.+?)\\]');

  const off = validateConfig({ subscriptionLabelPattern: '' });
  assert.strictEqual(off.valid, true);
  assert.strictEqual(off.config.subscriptionLabelPattern, '');
});

test('validateConfig: rejects a pattern that does not compile as a RegExp', () => {
  const res = validateConfig({ subscriptionLabelPattern: '(' }); // unbalanced paren
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('subscriptionLabelPattern')));
  // Rejected -> config keeps the default (the on-disk value would be left untouched by writeConfig).
  assert.strictEqual(res.config.subscriptionLabelPattern, DEFAULT_CONFIG.subscriptionLabelPattern);
});

test('validateConfig: rejects a non-string subscriptionLabelPattern', () => {
  const res = validateConfig({ subscriptionLabelPattern: 42 });
  assert.strictEqual(res.valid, false);
  assert.ok(res.errors.some((e) => e.includes('subscriptionLabelPattern')));
  assert.strictEqual(res.config.subscriptionLabelPattern, DEFAULT_CONFIG.subscriptionLabelPattern);
});

test('validateConfig: non-object input -> invalid, defaults returned', () => {
  const res = validateConfig(null);
  assert.strictEqual(res.valid, false);
  assert.deepStrictEqual(res.config, DEFAULT_CONFIG);
});

test('validateConfig: clamps negatives to 0 (still valid)', () => {
  const res = validateConfig({ longRunningThresholdMs: -1000, idleShutdownHours: -2 });
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.config.longRunningThresholdMs, 0);
  assert.strictEqual(res.config.idleShutdownHours, 0);
});

test('validateConfig: retentionDays is now an unknown key and is dropped', () => {
  // retentionDays and its auto-prune were removed; a stored value goes inert.
  const res = validateConfig({ retentionDays: 30 });
  assert.strictEqual(res.valid, true);
  assert.ok(!('retentionDays' in res.config));
});

test('validateConfig: coerces safe types (numeric strings, "true"/"false")', () => {
  const res = validateConfig({ port: '8080', sound: 'false', idleShutdownHours: '30' });
  assert.strictEqual(res.valid, true);
  assert.strictEqual(res.config.port, 8080);
  assert.strictEqual(res.config.sound, false);
  assert.strictEqual(res.config.idleShutdownHours, 30);
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

// paths.js reads its env vars lazily on every call, so overriding them keeps these tests
// off the real config/state dirs. Both posix and Windows vars are set, because which pair
// paths.js consults depends on the platform — which is exactly why the fixture path is
// handed to the callback from `paths.configPath()` and must never be hand-built. Building
// it as the POSIX XDG layout is what made the migration test below fail on Windows (where
// configDir() reads APPDATA, so the fixture sat where readConfig never looked) and, worse,
// made the malformed-json test pass VACUOUSLY there: it asserted the defaults that a
// missing file already returns, so the "never throws" path it exists to cover went unrun.
const CFG_ENV_KEYS = ['XDG_CONFIG_HOME', 'XDG_STATE_HOME', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'USERPROFILE'];

function withTempConfigDir(fn) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-cfg-'));
  const saved = {};
  for (const k of CFG_ENV_KEYS) saved[k] = process.env[k];
  try {
    process.env.XDG_CONFIG_HOME = path.join(tmp, 'config');
    process.env.XDG_STATE_HOME = path.join(tmp, 'state');
    process.env.APPDATA = path.join(tmp, 'appdata');
    process.env.LOCALAPPDATA = path.join(tmp, 'localappdata');
    process.env.HOME = tmp;
    process.env.USERPROFILE = tmp;
    // Resolved AFTER the override, so this is the file readConfig/writeConfig will use.
    const file = paths.configPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    return fn(file);
  } finally {
    for (const k of CFG_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

test('readConfig/writeConfig: round-trip through a temp dir', () => {
  withTempConfigDir(() => {
    // No file yet -> defaults.
    assert.deepStrictEqual(readConfig(), DEFAULT_CONFIG);

    const wrote = writeConfig({ port: 5555, events: { longRunning: true } });
    assert.strictEqual(wrote.ok, true);
    assert.strictEqual(wrote.config.port, 5555);

    const read = readConfig();
    assert.strictEqual(read.port, 5555);
    assert.strictEqual(read.events.longRunning, true);
    assert.strictEqual(read.idleShutdownHours, DEFAULT_CONFIG.idleShutdownHours); // defaults filled

    // Invalid write is rejected and leaves disk untouched.
    const bad = writeConfig({ port: 'nope' });
    assert.strictEqual(bad.ok, false);
    assert.ok(Array.isArray(bad.errors));
    assert.strictEqual(readConfig().port, 5555);
  });
});

// ---- one-time migration (migrateRawConfig) ----------------------------

test('migrateRawConfig: stale Opus 4.8 default is corrected and version stamped', () => {
  const raw = {
    cost: { rates: { 'claude-opus-4-8': { ...OLD_OPUS_48 }, 'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 } } },
  };
  const { config, changed } = migrateRawConfig(raw);
  assert.strictEqual(changed, true);
  assert.strictEqual(config.configVersion, CONFIG_VERSION);
  assert.deepStrictEqual(config.cost.rates['claude-opus-4-8'], NEW_OPUS_48);
  // The four required classes are untouched (this rate matched the shipped default,
  // so nothing was "corrected"), but v2->v3 fills in the new optional 1h rate.
  assert.deepStrictEqual(config.cost.rates['claude-haiku-4-5'], DEFAULT_CONFIG.cost.rates['claude-haiku-4-5']);
});

test('migrateRawConfig: detects the stale default even when numbers are quoted', () => {
  const raw = { cost: { rates: { 'claude-opus-4-8': { input: '15', output: '75', cacheRead: '1.5', cacheWrite: '18.75' } } } };
  assert.deepStrictEqual(migrateRawConfig(raw).config.cost.rates['claude-opus-4-8'], NEW_OPUS_48);
});

test('migrateRawConfig: a customized Opus 4.8 rate is preserved (only version stamped)', () => {
  const custom = { input: 12, output: 60, cacheRead: 1.2, cacheWrite: 15 };
  const { config, changed } = migrateRawConfig({ cost: { rates: { 'claude-opus-4-8': { ...custom } } } });
  assert.strictEqual(changed, true);
  assert.deepStrictEqual(config.cost.rates['claude-opus-4-8'], custom);
});

test('migrateRawConfig: a removed Opus 4.8 stays removed (never re-added)', () => {
  const raw = { cost: { rates: { 'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 } } } };
  const { config } = migrateRawConfig(raw);
  assert.strictEqual(config.cost.rates['claude-opus-4-8'], undefined);
});

test('migrateRawConfig: already at current version is a no-op (one-time guarantee)', () => {
  const raw = { configVersion: CONFIG_VERSION, cost: { rates: { 'claude-opus-4-8': { ...OLD_OPUS_48 } } } };
  const { config, changed } = migrateRawConfig(raw);
  assert.strictEqual(changed, false);
  // Once stamped, migration never touches the value again — even the old one.
  assert.deepStrictEqual(config.cost.rates['claude-opus-4-8'], OLD_OPUS_48);
});

test('migrateRawConfig: config without a rates map just gets the version stamp', () => {
  const { config, changed } = migrateRawConfig({ port: 5000 });
  assert.strictEqual(changed, true);
  assert.strictEqual(config.configVersion, CONFIG_VERSION);
});

test('readConfig: migrates a pre-version config on disk, persists once, then is idempotent', () => {
  withTempConfigDir((file) => {
    // A config saved before v0.6.3: no configVersion, stale Opus 4.8 rate.
    fs.writeFileSync(file, JSON.stringify({ port: 5555, cost: { rates: { 'claude-opus-4-8': OLD_OPUS_48 } } }));

    const read = readConfig();
    assert.strictEqual(read.port, 5555); // unrelated settings survive
    assert.deepStrictEqual(read.cost.rates['claude-opus-4-8'], NEW_OPUS_48);
    assert.strictEqual(read.configVersion, CONFIG_VERSION);

    // Unspecified fields still inherit live defaults (not frozen in memory).
    assert.strictEqual(read.idleShutdownHours, DEFAULT_CONFIG.idleShutdownHours);

    // The correction was persisted to disk (not just applied in memory)...
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.strictEqual(onDisk.configVersion, CONFIG_VERSION);
    assert.deepStrictEqual(onDisk.cost.rates['claude-opus-4-8'], NEW_OPUS_48);
    // ...but the persisted file keeps its MINIMAL shape: omitted fields are not
    // materialized, so a future default change still reaches this user.
    assert.strictEqual(onDisk.idleShutdownHours, undefined);
    assert.strictEqual(onDisk.cost.rates['claude-haiku-4-5'], undefined);

    // Second read is a stamped no-op — the value is stable, not re-touched.
    assert.deepStrictEqual(readConfig().cost.rates['claude-opus-4-8'], NEW_OPUS_48);
  });
});

test('readConfig: malformed json file -> defaults (never throws)', () => {
  withTempConfigDir((file) => {
    fs.writeFileSync(file, '{ this is not json ');
    // Pin the fixture to the path readConfig actually reads. Without this the test can go
    // vacuous again — a fixture written elsewhere leaves NO file, and a missing file
    // returns these same defaults, so the malformed-json branch would silently stop running.
    assert.ok(fs.existsSync(paths.configPath()));
    assert.deepStrictEqual(readConfig(), DEFAULT_CONFIG);
  });
});

// ---- v1 -> v2 migration: rate keys added in v2 -------------------------

test('migrateRawConfig: a v1 config gains the Opus 5 rate it could not have saved', () => {
  const raw = { configVersion: 1, cost: { rates: { 'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 } } } };
  const { config, changed } = migrateRawConfig(raw);
  assert.strictEqual(changed, true);
  assert.strictEqual(config.configVersion, CONFIG_VERSION);
  assert.deepStrictEqual(config.cost.rates['claude-opus-5'], DEFAULT_CONFIG.cost.rates['claude-opus-5']);
});

test('migrateRawConfig: an existing Opus 5 rate is never overwritten', () => {
  const custom = { input: 7, output: 30, cacheRead: 0.7, cacheWrite: 8 };
  const raw = { configVersion: 1, cost: { rates: { 'claude-opus-5': { ...custom } } } };
  assert.deepStrictEqual(migrateRawConfig(raw).config.cost.rates['claude-opus-5'], custom);
});

test('migrateRawConfig: no rates map -> nothing added (live defaults already apply)', () => {
  const { config } = migrateRawConfig({ configVersion: 1, port: 5000 });
  assert.strictEqual(config.cost, undefined);
  assert.strictEqual(config.configVersion, CONFIG_VERSION);
});

// ---- v2 -> v3 migration: the optional 1-hour cache-write rate --------------

test('migrateRawConfig: an UNTOUCHED default rate gains the new cacheWrite1h', () => {
  const untouched = { ...DEFAULT_CONFIG.cost.rates['claude-opus-4-8'] };
  delete untouched.cacheWrite1h; // as saved before the class existed
  const { config } = migrateRawConfig({ configVersion: 2, cost: { rates: { 'claude-opus-4-8': untouched } } });
  assert.strictEqual(config.cost.rates['claude-opus-4-8'].cacheWrite1h,
    DEFAULT_CONFIG.cost.rates['claude-opus-4-8'].cacheWrite1h);
});

test('migrateRawConfig: a CUSTOMIZED rate is NOT given a cacheWrite1h', () => {
  // Its own cacheWrite must keep governing both TTLs (pricing's fallback) — injecting
  // 2x-input here would silently re-price a number the user chose deliberately.
  const custom = { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 };
  const { config } = migrateRawConfig({ configVersion: 2, cost: { rates: { 'claude-opus-4-8': { ...custom } } } });
  assert.deepStrictEqual(config.cost.rates['claude-opus-4-8'], custom);
});

test('migrateRawConfig: an explicit cacheWrite1h is never overwritten', () => {
  const mine = { ...DEFAULT_CONFIG.cost.rates['claude-opus-4-8'], cacheWrite1h: 99 };
  const { config } = migrateRawConfig({ configVersion: 2, cost: { rates: { 'claude-opus-4-8': mine } } });
  assert.strictEqual(config.cost.rates['claude-opus-4-8'].cacheWrite1h, 99);
});

test('validateConfig: cacheWrite1h survives validation; absent stays absent (fallback applies)', () => {
  const withIt = validateConfig({ cost: { rates: { m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 } } } });
  assert.strictEqual(withIt.config.cost.rates.m.cacheWrite1h, 2);
  const without = validateConfig({ cost: { rates: { m: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1.25 } } } });
  assert.ok(without.valid);
  assert.strictEqual('cacheWrite1h' in without.config.cost.rates.m, false);
});
