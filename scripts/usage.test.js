'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { normalizeUsage, normalizeUsageWindow, sameUsageWindows, applyPattern, subLabel } = require('./usage');

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
    sessionId: null, // no session_id in the body
  });
});

test('normalizeUsage: windows are independent (one absent -> null, other kept)', () => {
  const out = normalizeUsage({ rate_limits: { five_hour: { used_percentage: 10, resets_at: 5 } } });
  assert.deepStrictEqual(out, { fiveHour: { usedPct: 10, resetsAt: 5000 }, sevenDay: null, sessionId: null });
});

test('normalizeUsage: passes through a non-empty session_id string', () => {
  const out = normalizeUsage({ session_id: 'abc-123', rate_limits: { five_hour: { used_percentage: 10, resets_at: 5 } } });
  assert.strictEqual(out.sessionId, 'abc-123');
});

test('normalizeUsage: malformed/absent session_id -> sessionId null (drop fails open)', () => {
  const rl = { five_hour: { used_percentage: 10, resets_at: 5 } };
  assert.strictEqual(normalizeUsage({ rate_limits: rl }).sessionId, null); // absent
  assert.strictEqual(normalizeUsage({ session_id: '', rate_limits: rl }).sessionId, null); // empty string
  assert.strictEqual(normalizeUsage({ session_id: 42, rate_limits: rl }).sessionId, null); // not a string
  assert.strictEqual(normalizeUsage({ session_id: null, rate_limits: rl }).sessionId, null);
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

// sameUsageWindows ignores the new sessionId field (only the numbers matter for broadcast).
test('sameUsageWindows: ignores sessionId (only rate-limit numbers gate a broadcast)', () => {
  const a = { fiveHour: { usedPct: 10, resetsAt: 1 }, sevenDay: null, sessionId: 's1' };
  const b = { fiveHour: { usedPct: 10, resetsAt: 1 }, sevenDay: null, sessionId: 's2' };
  assert.strictEqual(sameUsageWindows(a, b), true);
});

// ---- applyPattern ------------------------------------------------------

test('applyPattern: extracts capture group 1 (the parenthesized part)', () => {
  assert.strictEqual(applyPattern('FOSS Analytical (Lyra)', '\\(([^)]+)\\)'), 'Lyra');
});

test('applyPattern: falls back to the whole match when the pattern has no group', () => {
  assert.strictEqual(applyPattern('abc-123-xyz', '\\d+'), '123');
});

test('applyPattern: no match -> raw name unchanged', () => {
  assert.strictEqual(applyPattern('Plain Org Name', '\\(([^)]+)\\)'), 'Plain Org Name');
});

test('applyPattern: empty/non-string pattern -> raw name unchanged (identity/off)', () => {
  assert.strictEqual(applyPattern('FOSS (Lyra)', ''), 'FOSS (Lyra)');
  assert.strictEqual(applyPattern('FOSS (Lyra)', null), 'FOSS (Lyra)');
  assert.strictEqual(applyPattern('FOSS (Lyra)', undefined), 'FOSS (Lyra)');
});

test('applyPattern: invalid regex -> raw name unchanged (can never break the label)', () => {
  assert.strictEqual(applyPattern('FOSS (Lyra)', '('), 'FOSS (Lyra)'); // unbalanced paren won't compile
  assert.strictEqual(applyPattern('FOSS (Lyra)', '[a-'), 'FOSS (Lyra)');
});

test('applyPattern: an empty extraction falls back to the raw name (never blank)', () => {
  // group 1 exists but matches empty; return the raw name rather than ''.
  assert.strictEqual(applyPattern('hello', '(x*)'), 'hello');
});

test('applyPattern: non-string name is returned as-is', () => {
  assert.strictEqual(applyPattern(null, '\\d+'), null);
  assert.strictEqual(applyPattern(42, '\\d+'), 42);
});

// ---- subLabel ----------------------------------------------------------

test('subLabel: applies the config pattern to the subscription base name', () => {
  const teamSub = { id: 'o1', orgType: 'team', orgName: 'FOSS Analytical (Lyra)' };
  assert.strictEqual(subLabel(teamSub, { subscriptionLabelPattern: '\\(([^)]+)\\)' }), 'Lyra');
});

test('subLabel: a personal sub with no parens falls back to the raw name', () => {
  const personal = { id: 'p1', orgType: 'personal', displayName: 'Ada Lovelace' };
  assert.strictEqual(subLabel(personal, { subscriptionLabelPattern: '\\(([^)]+)\\)' }), 'Ada Lovelace');
});

test('subLabel: missing/blank pattern is identity (returns the raw base name)', () => {
  const teamSub = { id: 'o1', orgType: 'team', orgName: 'FOSS (Lyra)' };
  assert.strictEqual(subLabel(teamSub, { subscriptionLabelPattern: '' }), 'FOSS (Lyra)');
  assert.strictEqual(subLabel(teamSub, {}), 'FOSS (Lyra)'); // no field
  assert.strictEqual(subLabel(teamSub, null), 'FOSS (Lyra)'); // no cfg
});

test('subLabel: a null subscription labels as "Personal"', () => {
  assert.strictEqual(subLabel(null, { subscriptionLabelPattern: '\\(([^)]+)\\)' }), 'Personal');
});
