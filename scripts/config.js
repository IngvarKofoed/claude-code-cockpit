'use strict';

// Config read/merge/validate/write for claude-code-cockpit.
// The dashboard's Settings view is the intended editor (via the daemon's
// PUT /api/config), but config.json stays a plain hand-editable file. This
// module is the single owner of the schema + defaults so the daemon's
// boot-time load and the PUT handler share one validation path.

const fs = require('fs');
const paths = require('./paths');

const DEFAULT_CONFIG = {
  port: 4319,
  osNotifications: true,
  sound: true,
  browserSounds: true,
  activityDetail: 'tool', // 'tool' | 'args'
  events: { sessionFinished: true, needsInput: true, longRunning: false, turnFailed: true },
  longRunningThresholdMs: 300000,
  cost: {
    enabled: true,
    currency: 'USD',
    rates: {
      // USD per 1,000,000 tokens.
      'claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
      'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  },
  retentionDays: 90,
  idleShutdownHours: 0,
};

deepFreeze(DEFAULT_CONFIG);

// ---- small helpers -----------------------------------------------------

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function clone(v) {
  return structuredClone(v);
}

function deepFreeze(obj) {
  for (const key of Object.keys(obj)) {
    const v = obj[key];
    if (v !== null && typeof v === 'object') deepFreeze(v);
  }
  return Object.freeze(obj);
}

// Coerce to a finite number (accepts numeric strings); null if not possible.
function toNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function toInt(v) {
  const n = toNum(v);
  return n === null ? null : Math.trunc(n);
}

function toBool(v) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return null;
}

function clampMin(n, min) {
  return n < min ? min : n;
}

function validateRate(r) {
  if (!isPlainObject(r)) return null;
  const out = {};
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    const n = toNum(r[k]);
    if (n === null) return null;
    out[k] = clampMin(n, 0); // negative money rates are nonsensical
  }
  return out;
}

// ---- deep merge --------------------------------------------------------

// Deep-merge: nested plain objects are merged; arrays and scalars replace.
function mergeConfig(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return clone(override === undefined ? base : override);
  }
  const out = clone(base);
  for (const key of Object.keys(override)) {
    const ov = override[key];
    if (isPlainObject(out[key]) && isPlainObject(ov)) {
      out[key] = mergeConfig(out[key], ov);
    } else {
      out[key] = clone(ov);
    }
  }
  return out;
}

// ---- validation --------------------------------------------------------

// Validate a full or partial config. Always returns a fully-populated config
// (missing fields filled from defaults, unknown fields dropped). Type errors
// are collected and set valid:false; negatives are clamped (not an error).
function validateConfig(input) {
  const errors = [];
  const cfg = clone(DEFAULT_CONFIG);

  if (!isPlainObject(input)) {
    errors.push('config must be an object');
    return { valid: false, errors, config: cfg };
  }

  if ('port' in input) {
    const p = toInt(input.port);
    // Reject out-of-range ports: server.listen() throws ERR_SOCKET_BAD_PORT for
    // >65535, which would crash-loop the daemon on every revive. Rejecting keeps
    // the on-disk config untouched (writeConfig) rather than persisting a value
    // that bricks the dashboard.
    if (p === null || p < 1 || p > 65535) errors.push('port must be an integer between 1 and 65535');
    else cfg.port = p;
  }

  for (const key of ['osNotifications', 'sound', 'browserSounds']) {
    if (key in input) {
      const b = toBool(input[key]);
      if (b === null) errors.push(`${key} must be a boolean`);
      else cfg[key] = b;
    }
  }

  if ('activityDetail' in input) {
    if (input.activityDetail === 'tool' || input.activityDetail === 'args') {
      cfg.activityDetail = input.activityDetail;
    } else {
      errors.push('activityDetail must be "tool" or "args"');
    }
  }

  if ('events' in input) {
    if (!isPlainObject(input.events)) {
      errors.push('events must be an object');
    } else {
      for (const key of Object.keys(DEFAULT_CONFIG.events)) {
        if (key in input.events) {
          const b = toBool(input.events[key]);
          if (b === null) errors.push(`events.${key} must be a boolean`);
          else cfg.events[key] = b;
        }
      }
    }
  }

  // Thresholds / retention: numeric, negatives clamped to 0.
  for (const key of ['longRunningThresholdMs', 'retentionDays', 'idleShutdownHours']) {
    if (key in input) {
      const n = key === 'retentionDays' ? toInt(input[key]) : toNum(input[key]);
      if (n === null) errors.push(`${key} must be a number`);
      else cfg[key] = clampMin(n, 0);
    }
  }

  if ('cost' in input) {
    if (!isPlainObject(input.cost)) {
      errors.push('cost must be an object');
    } else {
      const c = input.cost;
      if ('enabled' in c) {
        const b = toBool(c.enabled);
        if (b === null) errors.push('cost.enabled must be a boolean');
        else cfg.cost.enabled = b;
      }
      if ('currency' in c) {
        if (typeof c.currency === 'string' && c.currency.trim() !== '') cfg.cost.currency = c.currency;
        else errors.push('cost.currency must be a non-empty string');
      }
      if ('rates' in c) {
        if (!isPlainObject(c.rates)) {
          errors.push('cost.rates must be an object');
        } else {
          // The provided rates map is authoritative: it REPLACES the defaults
          // wholesale rather than merging onto them, so a model removed in the
          // Settings UI (which sends the full map) — or in a hand-edited config —
          // actually stays removed. Default rates apply only when no `rates` key
          // is supplied at all. Invalid entries are flagged and dropped (they then
          // render as unpriced "—" rather than silently reverting to a default).
          const rates = {};
          for (const model of Object.keys(c.rates)) {
            const validated = validateRate(c.rates[model]);
            if (!validated) errors.push(`cost.rates.${model} must have numeric input/output/cacheRead/cacheWrite`);
            else rates[model] = validated;
          }
          cfg.cost.rates = rates;
        }
      }
    }
  }

  return { valid: errors.length === 0, errors, config: cfg };
}

// ---- read / write ------------------------------------------------------

// Deep-merge DEFAULT_CONFIG <- on-disk json, coercing/normalizing via
// validateConfig. Never throws: a missing or malformed file yields defaults.
function readConfig() {
  let disk = null;
  try {
    disk = JSON.parse(fs.readFileSync(paths.configPath(), 'utf8'));
  } catch (_e) {
    disk = null;
  }
  if (!isPlainObject(disk)) return clone(DEFAULT_CONFIG);
  return validateConfig(disk).config;
}

// Validate, then atomically persist (tmp file + rename in the same dir).
function writeConfig(input) {
  const { valid, errors, config } = validateConfig(input);
  if (!valid) return { ok: false, errors };
  try {
    paths.ensureDirs();
    const file = paths.configPath();
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(config, null, 2) + '\n');
    fs.renameSync(tmp, file);
    return { ok: true, config };
  } catch (e) {
    return { ok: false, errors: [String((e && e.message) || e)] };
  }
}

module.exports = {
  DEFAULT_CONFIG,
  readConfig,
  writeConfig,
  validateConfig,
  mergeConfig,
};
