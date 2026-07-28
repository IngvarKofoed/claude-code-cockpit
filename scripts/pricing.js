'use strict';

// Pure cost estimation. Rates are USD per 1,000,000 tokens:
// { input, output, cacheRead, cacheWrite, cacheWrite1h? }. Estimates only.

// The four rate classes a rate MUST define to count as priced. cacheWrite is the
// 5-minute-TTL cache-write rate.
const TOKEN_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];

// Usage carries a 5th class: 1-hour-TTL cache writes, which bill at 2x input vs
// the 5m rate's 1.25x. Claude Code writes a large share of its cache at 1h, so
// folding them into cacheWrite under-counts cost badly.
const USAGE_KEYS = [...TOKEN_KEYS, 'cacheWrite1h'];

// cacheWrite1h is OPTIONAL in a *rate*, falling back to the 5m cacheWrite rate.
// This is what keeps a rates map written before the class existed (or a
// hand-edited one) working: it prices 1h writes at the 5m rate — exactly the old
// behavior — instead of failing isCompleteRate and turning the model unpriced.
const RATE_FALLBACK = { cacheWrite1h: 'cacheWrite' };

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

// A transcript model id can carry suffixes the rate table doesn't key on:
// a context-window variant ("claude-opus-5[1m]") and/or a dated snapshot
// ("claude-haiku-4-5-20251001"). Strip both to get the base id. A dated
// snapshot always bills at its alias's price, so this is a pricing identity,
// not a guess. Order matters: the bracket goes last in an id, so strip it first.
function baseModelId(model) {
  if (typeof model !== 'string') return model;
  let out = model;
  const i = out.indexOf('[');
  if (i > 0) out = out.slice(0, i);
  out = out.replace(/-\d{8}$/, '');
  return out || model; // an id that is ONLY a suffix keeps its original form
}

// Resolve a model's rate, falling back to its base id when the exact variant
// has none: Opus 4.7+ and Sonnet 5 ship 1M context at standard pricing, so a
// "[1m]" variant bills at the base rate rather than showing as unpriced. An
// explicit variant entry still WINS, so a future premium long-context variant
// can be priced separately without touching this.
function resolveRate(model, rates) {
  if (!rates) return null;
  if (isCompleteRate(rates[model])) return rates[model];
  const base = baseModelId(model);
  if (base !== model && isCompleteRate(rates[base])) return rates[base];
  return null;
}

// Cost in USD for one model's usage given its rate table. Missing token/rate
// keys count as 0; a missing usage or rate object yields 0.
function costForModel(usage, rate) {
  if (!usage || !rate) return 0;
  let sum = 0;
  for (const k of USAGE_KEYS) {
    sum += num(usage[k]) * rateFor(rate, k);
  }
  return sum / 1e6;
}

// The rate for one usage class, applying RATE_FALLBACK when the class is absent
// or non-numeric (see RATE_FALLBACK for why that must not be an error).
function rateFor(rate, k) {
  if (!rate) return 0;
  const v = rate[k];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  const fb = RATE_FALLBACK[k];
  return fb ? num(rate[fb]) : 0;
}

// Cost split across the four DISPLAY classes (1-hour cache-write cost is folded
// into cacheWrite — it is a TTL of the same activity, not a separate kind of
// spend). Σ of the returned values === costForModel(usage, rate) by construction,
// which is the invariant the History cost-by-type chart depends on; computing it
// here rather than re-deriving the arithmetic at the call site is what keeps a
// newly added usage class from being silently dropped from that chart.
function costByClass(usage, rate) {
  const out = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  if (!usage || !rate) return out;
  for (const k of USAGE_KEYS) {
    const display = k === 'cacheWrite1h' ? 'cacheWrite' : k;
    out[display] += (num(usage[k]) * rateFor(rate, k)) / 1e6;
  }
  return out;
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
    const rate = resolveRate(model, rates);
    if (!rate) {
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

module.exports = {
  costForModel,
  costByClass,
  estimateCost,
  baseModelId,
  resolveRate,
  TOKEN_KEYS,
  USAGE_KEYS,
};
