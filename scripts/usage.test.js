'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeUsage, normalizeUsageWindow, sameUsageWindows } = require('./usage');

test('normalizeUsageWindow converts resets_at seconds -> ms and keeps usedPct', () => {
  assert.deepStrictEqual(normalizeUsageWindow({ used_percentage: 23.5, resets_at: 1738425600 }), {
    usedPct: 23.5,
    resetsAt: 1738425600000,
  });
});

test('normalizeUsageWindow clamps used_percentage to [0,100]', () => {
  assert.strictEqual(normalizeUsageWindow({ used_percentage: 250, resets_at: 1 }).usedPct, 100);
  assert.strictEqual(normalizeUsageWindow({ used_percentage: -5, resets_at: 1 }).usedPct, 0);
});

test('normalizeUsageWindow: non-finite used_percentage -> whole window null', () => {
  assert.strictEqual(normalizeUsageWindow({ used_percentage: 'nope', resets_at: 1 }), null);
  assert.strictEqual(normalizeUsageWindow({ resets_at: 1 }), null);
});

test('normalizeUsageWindow: non-positive/invalid resets_at -> resetsAt null, usedPct kept', () => {
  assert.deepStrictEqual(normalizeUsageWindow({ used_percentage: 40, resets_at: 0 }), { usedPct: 40, resetsAt: null });
  assert.deepStrictEqual(normalizeUsageWindow({ used_percentage: 40, resets_at: -3 }), { usedPct: 40, resetsAt: null });
  assert.deepStrictEqual(normalizeUsageWindow({ used_percentage: 40, resets_at: 'x' }), { usedPct: 40, resetsAt: null });
});

test('normalizeUsageWindow: non-object -> null', () => {
  assert.strictEqual(normalizeUsageWindow(null), null);
  assert.strictEqual(normalizeUsageWindow(42), null);
});

test('normalizeUsage: full body normalizes both windows', () => {
  const out = normalizeUsage({
    rate_limits: {
      five_hour: { used_percentage: 62, resets_at: 1000 },
      seven_day: { used_percentage: 45, resets_at: 2000 },
    },
  });
  assert.deepStrictEqual(out, {
    fiveHour: { usedPct: 62, resetsAt: 1000000 },
    sevenDay: { usedPct: 45, resetsAt: 2000000 },
  });
});

test('normalizeUsage: windows are independent (one absent -> null, other kept)', () => {
  const out = normalizeUsage({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 5 } } });
  assert.deepStrictEqual(out, { fiveHour: { usedPct: 10, resetsAt: 5000 }, sevenDay: null });
});

test('normalizeUsage: malformed body -> null (DROP, no partial update)', () => {
  assert.strictEqual(normalizeUsage(null), null);
  assert.strictEqual(normalizeUsage('x'), null);
  assert.strictEqual(normalizeUsage({}), null); // no rate_limits
  assert.strictEqual(normalizeUsage({ rate_limits: 5 }), null); // rate_limits not an object
});

test('sameUsageWindows: identical numbers -> true, any diff -> false', () => {
  const a = { fiveHour: { usedPct: 62, resetsAt: 1000 }, sevenDay: { usedPct: 45, resetsAt: 2000 } };
  assert.strictEqual(sameUsageWindows(a, { fiveHour: { usedPct: 62, resetsAt: 1000 }, sevenDay: { usedPct: 45, resetsAt: 2000 } }), true);
  assert.strictEqual(sameUsageWindows(a, { fiveHour: { usedPct: 63, resetsAt: 1000 }, sevenDay: { usedPct: 45, resetsAt: 2000 } }), false);
  assert.strictEqual(sameUsageWindows(a, { fiveHour: { usedPct: 62, resetsAt: 1001 }, sevenDay: { usedPct: 45, resetsAt: 2000 } }), false);
});

test('sameUsageWindows: null windows compare equal; a null snapshot is never equal', () => {
  assert.strictEqual(sameUsageWindows({ fiveHour: null, sevenDay: null }, { fiveHour: null, sevenDay: null }), true);
  assert.strictEqual(sameUsageWindows({ fiveHour: { usedPct: 1, resetsAt: 1 }, sevenDay: null }, { fiveHour: null, sevenDay: null }), false);
  assert.strictEqual(sameUsageWindows(null, { fiveHour: null, sevenDay: null }), false);
});
