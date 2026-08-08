'use strict';
const test = require('node:test');
const assert = require('node:assert');
const {
  normalizeUsage,
  normalizeUsageWindow,
  normalizeContextWindow,
  pushSessionId,
  sameUsageWindows,
  appendUsageSample,
  pruneUsageSamples,
  usageSampleSlice,
  applyPattern,
  subLabel,
  TREND_SPAN_MS,
  SAMPLE_RETENTION,
} = require('./usage');

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

// ---- normalizeContextWindow --------------------------------------------

test('normalizeContextWindow: keeps usedPct and sums the two token counts', () => {
  assert.deepStrictEqual(
    normalizeContextWindow({ used_percentage: 62.4, total_input_tokens: 100000, total_output_tokens: 20000 }),
    { usedPct: 62.4, tokens: 120000 }
  );
});

test('normalizeContextWindow clamps used_percentage to [0,100]', () => {
  assert.strictEqual(normalizeContextWindow({ used_percentage: 250 }).usedPct, 100);
  assert.strictEqual(normalizeContextWindow({ used_percentage: -5 }).usedPct, 0);
});

test('normalizeContextWindow: non-finite used_percentage -> whole window null', () => {
  assert.strictEqual(normalizeContextWindow({ used_percentage: 'nope', total_input_tokens: 5 }), null);
  assert.strictEqual(normalizeContextWindow({ total_input_tokens: 5 }), null);
});

test('normalizeContextWindow: absent token counts -> tokens null, never a wrong zero', () => {
  assert.deepStrictEqual(normalizeContextWindow({ used_percentage: 40 }), { usedPct: 40, tokens: null });
  assert.deepStrictEqual(normalizeContextWindow({ used_percentage: 40, total_input_tokens: 'x' }), {
    usedPct: 40,
    tokens: null,
  });
});

test('normalizeContextWindow: one token count present is summed alone', () => {
  assert.deepStrictEqual(normalizeContextWindow({ used_percentage: 40, total_input_tokens: 900 }), {
    usedPct: 40,
    tokens: 900,
  });
  assert.deepStrictEqual(normalizeContextWindow({ used_percentage: 40, total_output_tokens: 7 }), {
    usedPct: 40,
    tokens: 7,
  });
});

test('normalizeContextWindow: non-object -> null', () => {
  assert.strictEqual(normalizeContextWindow(null), null);
  assert.strictEqual(normalizeContextWindow(42), null);
  assert.strictEqual(normalizeContextWindow(undefined), null);
});

// ---- pushSessionId -----------------------------------------------------

test('pushSessionId: a non-empty string passes through', () => {
  assert.strictEqual(pushSessionId({ session_id: 'abc-123' }), 'abc-123');
});

test('pushSessionId: absent/blank/non-string -> null (attribution fails open)', () => {
  assert.strictEqual(pushSessionId({}), null);
  assert.strictEqual(pushSessionId({ session_id: '' }), null);
  assert.strictEqual(pushSessionId({ session_id: 42 }), null);
  assert.strictEqual(pushSessionId({ session_id: null }), null);
  assert.strictEqual(pushSessionId(null), null);
  assert.strictEqual(pushSessionId('x'), null);
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

// ---- weekly percentage sample buffer ----------------------------------------

const H = 3600 * 1000;
const T0 = 1785000000000; // fixed clock; these helpers must never read the wall clock

// Append a series of [hoursAgo, pct] readings for one subscription, newest last.
function buildSamples(readings, sub = 's1', now = T0) {
  let out = [];
  for (const [hoursAgo, pct] of readings) {
    out = appendUsageSample(out, { t: now - hoursAgo * H, pct, sub }, now);
  }
  return out;
}

test('appendUsageSample: records a change and ignores an unchanged repeat', () => {
  let s = appendUsageSample([], { t: T0 - 2 * H, pct: 90, sub: 'a' }, T0);
  assert.strictEqual(s.length, 1);
  const same = appendUsageSample(s, { t: T0 - H, pct: 90, sub: 'a' }, T0);
  assert.strictEqual(same, s, 'an unchanged percentage returns the input array untouched');
  s = appendUsageSample(s, { t: T0, pct: 91, sub: 'a' }, T0);
  assert.deepStrictEqual(s.map((x) => x.pct), [90, 91]);
});

test('appendUsageSample: drops garbage entries rather than storing them', () => {
  const s = [{ t: T0, pct: 5, sub: 'a' }];
  assert.strictEqual(appendUsageSample(s, { t: NaN, pct: 6, sub: 'a' }, T0), s);
  assert.strictEqual(appendUsageSample(s, { t: T0, pct: 'x', sub: 'a' }, T0), s);
  assert.strictEqual(appendUsageSample(s, null, T0), s);
});

test('appendUsageSample: subscriptions are independent, and undefined buckets as null', () => {
  let s = appendUsageSample([], { t: T0 - 2 * H, pct: 90, sub: 'a' }, T0);
  s = appendUsageSample(s, { t: T0 - H, pct: 12, sub: 'b' }, T0);
  // 90 is subscription a's last value, not b's — b must still record its own 90.
  s = appendUsageSample(s, { t: T0, pct: 90, sub: 'b' }, T0);
  assert.deepStrictEqual(s.map((x) => [x.sub, x.pct]), [['a', 90], ['b', 12], ['b', 90]]);
  const withNull = appendUsageSample(s, { t: T0, pct: 3 }, T0);
  assert.strictEqual(withNull[withNull.length - 1].sub, null, 'a missing sub normalizes to null');
});

test('appendUsageSample: a steep drop discards that subscription history (window reset)', () => {
  let s = buildSamples([[6, 88], [4, 92], [2, 95]]);
  s = appendUsageSample(s, { t: T0, pct: 2, sub: 's1' }, T0);
  assert.deepStrictEqual(s.map((x) => x.pct), [2], 'pre-reset samples would anchor a false delta');
});

test('appendUsageSample: a small decrease is kept (a rolling window ages usage out)', () => {
  const s = buildSamples([[6, 88], [4, 92], [2, 91]]);
  assert.deepStrictEqual(s.map((x) => x.pct), [88, 92, 91]);
});

test('appendUsageSample: a steep drop spares OTHER subscriptions', () => {
  let s = buildSamples([[6, 88], [4, 92]], 'a');
  s = appendUsageSample(s, { t: T0 - 3 * H, pct: 40, sub: 'b' }, T0);
  s = appendUsageSample(s, { t: T0, pct: 1, sub: 'a' }, T0);
  assert.deepStrictEqual(s.map((x) => [x.sub, x.pct]), [['b', 40], ['a', 1]]);
});

test('pruneUsageSamples: keeps the newest out-of-horizon sample per subscription as an anchor', () => {
  const old = T0 - (SAMPLE_RETENTION.sevenDay.horizonMs + 20 * H);
  const s = pruneUsageSamples(
    [
      { t: old - H, pct: 10, sub: 'a' },
      { t: old, pct: 11, sub: 'a' },
      { t: old, pct: 50, sub: 'b' },
      { t: T0 - H, pct: 12, sub: 'a' },
    ],
    T0,
    SAMPLE_RETENTION.sevenDay
  );
  // The oldest 'a' is dropped; the newest out-of-horizon one survives for BOTH subs, so a
  // long flat stretch can still be measured instead of never resolving an anchor.
  assert.deepStrictEqual(s.map((x) => [x.sub, x.pct]), [['a', 11], ['b', 50], ['a', 12]]);
});

test('pruneUsageSamples: caps a runaway buffer, keeping the newest', () => {
  const cap = SAMPLE_RETENTION.sevenDay.maxSamples;
  const many = [];
  for (let i = 0; i < cap + 50; i++) many.push({ t: T0 - (cap - i) * 1000, pct: i, sub: 'a' });
  const s = pruneUsageSamples(many, T0, SAMPLE_RETENTION.sevenDay);
  assert.strictEqual(s.length, cap);
  assert.strictEqual(s[s.length - 1].pct, cap + 49);
});

// The 5h buffer has its own, much shorter horizon: its percentage resets every 5 hours and
// ticks far more often per day, so sharing the weekly horizon would let it crowd out the
// weekly history. Same input, two retentions, different survivors.
test('pruneUsageSamples: retention is per buffer, so the 5h horizon prunes harder', () => {
  const input = [
    { t: T0 - 5 * H, pct: 20, sub: 'a' },
    { t: T0 - 3 * H, pct: 40, sub: 'a' },
    { t: T0 - 20 * 60 * 1000, pct: 60, sub: 'a' },
  ];
  const weekly = pruneUsageSamples(input, T0, SAMPLE_RETENTION.sevenDay);
  assert.deepStrictEqual(weekly.map((x) => x.pct), [20, 40, 60], 'all inside a 6h horizon');
  const five = pruneUsageSamples(input, T0, SAMPLE_RETENTION.fiveHour);
  // 5h and 3h ago are both past the 1h horizon, so only the NEWEST of them survives as the
  // anchor — the older one is dropped rather than both being kept.
  assert.deepStrictEqual(five.map((x) => x.pct), [40, 60]);
});

test('pruneUsageSamples: an omitted retention falls back to the weekly one', () => {
  const input = [{ t: T0 - 3 * H, pct: 40, sub: 'a' }, { t: T0, pct: 60, sub: 'a' }];
  assert.deepStrictEqual(
    pruneUsageSamples(input, T0).map((x) => x.pct),
    pruneUsageSamples(input, T0, SAMPLE_RETENTION.sevenDay).map((x) => x.pct)
  );
});

// The spans the browser mirrors (web/app.js:TREND_SPAN_MS). Pinned so a change here has to be
// made deliberately on both sides — nothing links the two files.
test('TREND_SPAN_MS: 30 minutes on the 5h bar, 6 hours on the weekly', () => {
  assert.strictEqual(TREND_SPAN_MS.fiveHour, 30 * 60 * 1000);
  assert.strictEqual(TREND_SPAN_MS.sevenDay, 6 * H);
  // The 5h buffer must retain at least its own span, or a full-span lookback could never
  // resolve an in-horizon sample to measure from.
  assert.ok(SAMPLE_RETENTION.fiveHour.horizonMs >= TREND_SPAN_MS.fiveHour);
  assert.ok(SAMPLE_RETENTION.sevenDay.horizonMs >= TREND_SPAN_MS.sevenDay);
});

test('usageSampleSlice: returns the in-window samples plus one anchor outside it', () => {
  const s = buildSamples([[20, 70], [8, 80], [4, 86], [1, 90]]);
  const slice = usageSampleSlice(s, 's1', T0, 6 * H);
  // 8h-ago is the anchor (newest at or before the 6h cutoff); 20h-ago is not carried.
  assert.deepStrictEqual(slice.map((x) => x.pct), [80, 86, 90]);
});

test('usageSampleSlice: no sample old enough yields no anchor (the "measuring" state)', () => {
  const s = buildSamples([[2, 86], [1, 90]]);
  const slice = usageSampleSlice(s, 's1', T0, 6 * H);
  assert.deepStrictEqual(slice.map((x) => x.pct), [86, 90]);
  assert.ok(!slice.some((x) => x.t <= T0 - 6 * H), 'nothing at or before the cutoff — the client reads this as unmeasurable');
});

test('usageSampleSlice: filters to one subscription, so a switch cannot cross-contaminate', () => {
  let s = buildSamples([[8, 80], [1, 90]], 'a');
  s = appendUsageSample(s, { t: T0 - 7 * H, pct: 30, sub: 'b' }, T0);
  s = appendUsageSample(s, { t: T0 - 2 * H, pct: 33, sub: 'b' }, T0);
  assert.deepStrictEqual(usageSampleSlice(s, 'a', T0, 6 * H).map((x) => x.pct), [80, 90]);
  assert.deepStrictEqual(usageSampleSlice(s, 'b', T0, 6 * H).map((x) => x.pct), [30, 33]);
});

test('usageSampleSlice: a null subscription is its own bucket, not a wildcard', () => {
  let s = appendUsageSample([], { t: T0 - 8 * H, pct: 40, sub: null }, T0);
  s = appendUsageSample(s, { t: T0 - H, pct: 44, sub: 'a' }, T0);
  assert.deepStrictEqual(usageSampleSlice(s, null, T0, 6 * H).map((x) => x.pct), [40]);
});

test('usageSampleSlice: no lookback (whole-window basis) ships nothing', () => {
  const s = buildSamples([[8, 80], [1, 90]]);
  assert.deepStrictEqual(usageSampleSlice(s, 's1', T0, 0), []);
  assert.deepStrictEqual(usageSampleSlice(null, 's1', T0, 6 * H), []);
});
