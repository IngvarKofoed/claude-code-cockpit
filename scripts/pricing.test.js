'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { costForModel, costByClass, estimateCost, baseModelId } = require('./pricing');

// Float-tolerant comparison for money math.
function approx(actual, expected, msg) {
  assert.ok(Math.abs(actual - expected) < 1e-9, msg || `${actual} !~= ${expected}`);
}

const SONNET = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

test('costForModel: known-model math (input + output)', () => {
  const usage = { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 };
  approx(costForModel(usage, SONNET), 3 + 30); // 1M*3 + 2M*15 per 1M
});

test('costForModel: cacheRead and cacheWrite contribute', () => {
  const usage = { input: 0, output: 0, cacheRead: 2_000_000, cacheWrite: 4_000_000 };
  approx(costForModel(usage, SONNET), 0.6 + 15); // 2M*0.3 + 4M*3.75
});

test('costForModel: missing usage keys default to 0', () => {
  approx(costForModel({ input: 1_000_000 }, SONNET), 3);
});

test('costForModel: null usage or rate -> 0 (no throw)', () => {
  assert.strictEqual(costForModel(null, SONNET), 0);
  assert.strictEqual(costForModel({ input: 1000 }, null), 0);
  assert.strictEqual(costForModel(undefined, undefined), 0);
});

test('estimateCost: empty byModel -> zeroed result', () => {
  assert.deepStrictEqual(estimateCost({}, { 'claude-sonnet-5': SONNET }), {
    total: 0,
    byModel: {},
    unpriced: [],
  });
});

test('estimateCost: single priced model', () => {
  const byModel = { 'claude-sonnet-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const res = estimateCost(byModel, { 'claude-sonnet-5': SONNET });
  approx(res.total, 3);
  approx(res.byModel['claude-sonnet-5'], 3);
  assert.deepStrictEqual(res.unpriced, []);
});

test('estimateCost: unknown model -> null cost, listed unpriced, total null', () => {
  const byModel = { 'mystery-model': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } };
  const res = estimateCost(byModel, { 'claude-sonnet-5': SONNET });
  assert.strictEqual(res.byModel['mystery-model'], null);
  assert.deepStrictEqual(res.unpriced, ['mystery-model']);
  assert.strictEqual(res.total, null); // ALL models unpriced
});

test('estimateCost: mixed priced/unpriced -> total counts priced only', () => {
  const byModel = {
    'claude-sonnet-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, // $3
    'mystery-model': { input: 5_000_000, output: 5_000_000, cacheRead: 0, cacheWrite: 0 },
  };
  const res = estimateCost(byModel, { 'claude-sonnet-5': SONNET });
  approx(res.total, 3); // unpriced model contributes nothing
  approx(res.byModel['claude-sonnet-5'], 3);
  assert.strictEqual(res.byModel['mystery-model'], null);
  assert.deepStrictEqual(res.unpriced, ['mystery-model']);
});

test('estimateCost: multiple priced models sum', () => {
  const HAIKU = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  const byModel = {
    'claude-sonnet-5': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, // $3
    'claude-haiku-4-5': { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, // $2
  };
  const res = estimateCost(byModel, { 'claude-sonnet-5': SONNET, 'claude-haiku-4-5': HAIKU });
  approx(res.total, 5);
  approx(res.byModel['claude-sonnet-5'], 3);
  approx(res.byModel['claude-haiku-4-5'], 2);
  assert.deepStrictEqual(res.unpriced, []);
});

test('estimateCost: incomplete rate (missing a token class) -> unpriced, not a $0 undercount', () => {
  const byModel = { 'partial-model': { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0 } };
  const res = estimateCost(byModel, { 'partial-model': { input: 3 } }); // missing output/cacheRead/cacheWrite
  assert.strictEqual(res.byModel['partial-model'], null);
  assert.deepStrictEqual(res.unpriced, ['partial-model']);
  assert.strictEqual(res.total, null);
});

test('estimateCost: missing rates argument -> everything unpriced, total null', () => {
  const byModel = { 'claude-sonnet-5': { input: 1_000_000 } };
  const res = estimateCost(byModel, undefined);
  assert.strictEqual(res.byModel['claude-sonnet-5'], null);
  assert.strictEqual(res.total, null);
  assert.deepStrictEqual(res.unpriced, ['claude-sonnet-5']);
});

test('estimateCost: non-object byModel -> safe zeroed result', () => {
  assert.deepStrictEqual(estimateCost(null, {}), { total: 0, byModel: {}, unpriced: [] });
});

// ---- context-window variant ids ("[1m]") -------------------------------

test('baseModelId: strips a bracketed context-window suffix, leaves plain ids', () => {
  assert.strictEqual(baseModelId('claude-opus-5[1m]'), 'claude-opus-5');
  assert.strictEqual(baseModelId('claude-opus-5'), 'claude-opus-5');
  assert.strictEqual(baseModelId('[weird]'), '[weird]'); // no base id to fall back to
  assert.strictEqual(baseModelId(undefined), undefined);
});

test('estimateCost: a "[1m]" variant prices at its base model rate, not unpriced', () => {
  const OPUS = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const byModel = { 'claude-opus-5[1m]': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const res = estimateCost(byModel, { 'claude-opus-5': OPUS });
  approx(res.total, 5);
  approx(res.byModel['claude-opus-5[1m]'], 5);
  assert.deepStrictEqual(res.unpriced, []);
});

test('estimateCost: an explicit variant rate wins over the base fallback', () => {
  const byModel = { 'claude-opus-5[1m]': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const res = estimateCost(byModel, {
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-5[1m]': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  });
  approx(res.total, 10);
});

test('estimateCost: variant with no base rate stays unpriced (no wrong $0)', () => {
  const byModel = { 'mystery-model[1m]': { input: 1_000_000 } };
  const res = estimateCost(byModel, { 'claude-opus-5': SONNET });
  assert.strictEqual(res.byModel['mystery-model[1m]'], null);
  assert.deepStrictEqual(res.unpriced, ['mystery-model[1m]']);
  assert.strictEqual(res.total, null);
});

test('estimateCost: an INCOMPLETE variant rate falls back to a complete base rate', () => {
  const byModel = { 'claude-opus-5[1m]': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const res = estimateCost(byModel, {
    'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    'claude-opus-5[1m]': { input: 99 }, // partial -> not authoritative
  });
  approx(res.total, 5);
});

test('baseModelId: strips a dated snapshot suffix, and both suffixes together', () => {
  assert.strictEqual(baseModelId('claude-haiku-4-5-20251001'), 'claude-haiku-4-5');
  assert.strictEqual(baseModelId('claude-3-5-haiku-20241022'), 'claude-3-5-haiku');
  assert.strictEqual(baseModelId('claude-opus-4-1-20250805[1m]'), 'claude-opus-4-1');
  // A version-like tail that is NOT 8 digits must survive (e.g. "claude-opus-4-5").
  assert.strictEqual(baseModelId('claude-opus-4-5'), 'claude-opus-4-5');
  assert.strictEqual(baseModelId('claude-sonnet-4-6'), 'claude-sonnet-4-6');
  assert.strictEqual(baseModelId('-20251001'), '-20251001'); // suffix-only keeps its form
});

test('estimateCost: a dated snapshot id prices at its alias rate', () => {
  const HAIKU = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 };
  const byModel = { 'claude-haiku-4-5-20251001': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const res = estimateCost(byModel, { 'claude-haiku-4-5': HAIKU });
  approx(res.total, 1);
  assert.deepStrictEqual(res.unpriced, []);
});

// ---- 1-hour cache writes ------------------------------------------------

const OPUS = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 };

test('costForModel: 1h cache writes bill at the 1h rate, not the 5m one', () => {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1_000_000, cacheWrite1h: 1_000_000 };
  approx(costForModel(usage, OPUS), 6.25 + 10);
});

test('costForModel: a rate with NO cacheWrite1h falls back to the 5m rate', () => {
  // This is the compatibility path: a rates map saved before the class existed must
  // keep pricing exactly as it did, NOT price 1h writes at 0.
  const legacy = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWrite1h: 1_000_000 };
  approx(costForModel(usage, legacy), 6.25);
});

test('isCompleteRate: a rate without cacheWrite1h is still PRICED (not unpriced)', () => {
  const legacy = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const res = estimateCost({ m: { cacheWrite1h: 1_000_000 } }, { m: legacy });
  assert.deepStrictEqual(res.unpriced, []); // the whole dashboard would go "—" otherwise
  approx(res.total, 6.25);
});

test('costByClass: sums EXACTLY to costForModel, with 1h folded into cacheWrite', () => {
  const usage = { input: 1e6, output: 2e6, cacheRead: 3e6, cacheWrite: 4e6, cacheWrite1h: 5e6 };
  const split = costByClass(usage, OPUS);
  const sum = split.input + split.output + split.cacheRead + split.cacheWrite;
  approx(sum, costForModel(usage, OPUS)); // the History cost-by-type invariant
  approx(split.cacheWrite, 4 * 6.25 + 5 * 10); // both TTLs land in the one band
  assert.deepStrictEqual(Object.keys(split).sort(), ['cacheRead', 'cacheWrite', 'input', 'output']);
});

test('costByClass: honours the base-id fallback caller and a legacy rate', () => {
  const legacy = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 1e6, cacheWrite1h: 1e6 };
  approx(costByClass(usage, legacy).cacheWrite, 12.5);
});

test('USAGE_KEYS is TOKEN_KEYS plus cacheWrite1h, and every module agrees on it', () => {
  const { USAGE_KEYS, TOKEN_KEYS } = require('./pricing');
  assert.deepStrictEqual(USAGE_KEYS, [...TOKEN_KEYS, 'cacheWrite1h']);
  // The pure modules keep their own copies of the class list (they don't import
  // pricing); if one drifts, tokens silently stop being counted somewhere.
  const fromTranscript = Object.keys(require('./transcript').__testEmptyTokens());
  const fromAggregate = Object.keys(require('./aggregate').__testEmptyTokens());
  assert.deepStrictEqual(fromTranscript.sort(), [...USAGE_KEYS].sort());
  assert.deepStrictEqual(fromAggregate.sort(), [...USAGE_KEYS].sort());
});
