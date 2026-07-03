'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { costForModel, estimateCost } = require('./pricing');

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
