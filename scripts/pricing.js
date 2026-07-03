'use strict';

// Pure cost estimation. Rates are USD per 1,000,000 tokens:
// { input, output, cacheRead, cacheWrite }. Figures are estimates only.

const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// Coerce anything non-finite (undefined, null, NaN, strings) to 0 so bad input
// can never throw or poison the sum.
function num(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

// A rate is "complete" only when every token class is a finite number. A partial
// rate (e.g. { input: 3 }) is treated as unpriced rather than pricing the missing
// classes at 0, which would silently under-count cost.
function isCompleteRate(rate) {
  if (!rate || typeof rate !== 'object') return false;
  for (const k of TOKEN_KEYS) {
    if (typeof rate[k] !== 'number' || !Number.isFinite(rate[k])) return false;
  }
  return true;
}

// Cost in USD for one model's usage given its rate table. Missing token/rate
// keys count as 0; a missing usage or rate object yields 0.
function costForModel(usage, rate) {
  if (!usage || !rate) return 0;
  let sum = 0;
  for (const k of TOKEN_KEYS) {
    sum += num(usage[k]) * num(rate[k]);
  }
  return sum / 1e6;
}

// Estimate cost across a set of models.
// byModel: { modelId: { input, output, cacheRead, cacheWrite } }
// rates:   { modelId: { input, output, cacheRead, cacheWrite } }
// A model with no configured rate yields byModel[m] === null (render as "—",
// never $0) and is listed in `unpriced`. `total` sums only the priced models;
// it is null only when at least one model is present and every one is unpriced.
// Empty input -> { total: 0, byModel: {}, unpriced: [] }.
function estimateCost(byModel, rates) {
  const result = { total: 0, byModel: {}, unpriced: [] };
  if (!byModel || typeof byModel !== 'object') return result;

  const models = Object.keys(byModel);
  if (models.length === 0) return result;

  let pricedCount = 0;
  let total = 0;
  for (const model of models) {
    const rate = rates && rates[model];
    if (!isCompleteRate(rate)) {
      // No rate, or an incomplete one -> unpriced ("—"), never a $0 undercount.
      result.byModel[model] = null;
      result.unpriced.push(model);
      continue;
    }
    const cost = costForModel(byModel[model], rate);
    result.byModel[model] = cost;
    total += cost;
    pricedCount++;
  }

  result.total = pricedCount === 0 ? null : total;
  return result;
}

module.exports = { costForModel, estimateCost };
