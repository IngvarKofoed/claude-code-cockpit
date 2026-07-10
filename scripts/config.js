'use strict';

// Config read/merge/validate/write for claude-code-cockpit.
// The dashboard's Settings view is the intended editor (via the daemon's
// PUT /api/config), but config.json stays a plain hand-editable file. This
// module is the single owner of the schema + defaults so the daemon's
// boot-time load and the PUT handler share one validation path.

const fs = require('fs');
const paths = require('./paths');

// Schema version for one-time config migrations (see migrateRawConfig). Bump
// this when a shipped default changes in a way that must reach users who have
// already persisted the old value, and add the matching migration below.
const CONFIG_VERSION = 1;

const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  port: 4319,
  osNotifications: true,
  sound: true,
  browserSounds: true,
  activityDetail: 'tool', // 'tool' | 'args'
  usagePace: 'both', // 'both' | 'tick' | 'delta' | 'off' — Live usage-bar pace cue
  events: { sessionFinished: true, needsInput: true, longRunning: false, turnFailed: true },
  longRunningThresholdMs: 300000,
  // Pause gate: opt-in master switch (default off) + optional usage auto-pilot.
  // autoPauseFiveHourPct is the 5h rate-limit threshold that auto-pauses (0 = off).
  pauseGateEnabled: false,
  autoPauseFiveHourPct: 0,
  cost: {
    enabled: true,
    currency: 'USD',
    rates: {
      // USD per 1,000,000 tokens. cacheWrite is the 5-minute-TTL rate
      // (1.25x input, Claude Code's default); cacheRead is 0.1x input.
      'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
      'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
      // Sonnet 5 has an intro rate of $2/$10 through 2026-08-31; this is the
      // standard post-intro rate it reverts to (see docs/CHANGELOG.md).
      'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
    },
  },
  idleShutdownHours: 0,
};

deepFreeze(DEFAULT_CONFIG);

// The rates that were DEFAULT at configVersion 0 and were corrected in v1. The
// v0->v1 migration upgrades a persisted rate still equal to one of these to the
// current default. The match is by VALUE (a v0 config carries no provenance), so
// a rate a user deliberately left identical to the old default is upgraded too —
// an accepted trade-off: the only affected value ($15/$75 for Opus 4.8) is ~3x
// the real price and never a rate anyone sets on purpose. One value per model:
// migrations run per version step, so each step compares against just the
// previous shipped default, never a full history.
const PRE_V1_DEFAULT_RATES = {
  // v0.6.2 and earlier priced Opus 4.8 at the retired Opus 4.1/4.0 tier
  // ($15/$75, ~3x too high); corrected to the Opus 4.5+ tier in v0.6.3.
  'claude-opus-4-8': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
};
deepFreeze(PRE_V1_DEFAULT_RATES);

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

// Deep-equality for a rate entry, tolerant of numeric strings (a hand-edited
// config may quote numbers), comparing only the four token classes.
function ratesEqual(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  for (const k of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (toNum(a[k]) !== toNum(b[k])) return false;
  }
  return true;
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

  // Internal, not user-editable: carry a valid on-disk version so a migrated or
  // future-versioned config keeps its stamp; ignore junk (don't fail the PUT).
  if ('configVersion' in input) {
    const n = toInt(input.configVersion);
    if (n !== null && n >= 0) cfg.configVersion = n;
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

  for (const key of ['osNotifications', 'sound', 'browserSounds', 'pauseGateEnabled']) {
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

  if ('usagePace' in input) {
    if (['both', 'tick', 'delta', 'off'].includes(input.usagePace)) {
      cfg.usagePace = input.usagePace;
    } else {
      errors.push('usagePace must be "both", "tick", "delta", or "off"');
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

  // Thresholds: numeric, negatives clamped to 0.
  for (const key of ['longRunningThresholdMs', 'idleShutdownHours']) {
    if (key in input) {
      const n = toNum(input[key]);
      if (n === null) errors.push(`${key} must be a number`);
      else cfg[key] = clampMin(n, 0);
    }
  }

  // Usage auto-pilot threshold: a percentage clamped to [0,100] (0 = off).
  if ('autoPauseFiveHourPct' in input) {
    const n = toNum(input.autoPauseFiveHourPct);
    if (n === null) errors.push('autoPauseFiveHourPct must be a number');
    else cfg.autoPauseFiveHourPct = Math.min(100, clampMin(n, 0));
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

// ---- one-time migrations -----------------------------------------------

// Apply schema migrations to a RAW on-disk config object (before validation,
// so the true stored configVersion is visible). Returns { config, changed };
// `changed` is true when anything — a rate or the version stamp — was updated,
// so readConfig can persist the result exactly once. Working on the raw shape
// (not the validated config) is what lets us tell a stale default apart from a
// value the user deliberately kept.
function migrateRawConfig(raw) {
  const stored = toInt(raw && raw.configVersion);
  const from = stored === null || stored < 0 ? 0 : stored;
  if (from >= CONFIG_VERSION) return { config: raw, changed: false };

  const out = clone(raw);
  // v0 -> v1: upgrade any rate still equal to its pre-v1 default (e.g. the old
  // Opus 4.8 $15/$75 tier) to the current default. A rate the user changed to a
  // different value is preserved; a model they removed isn't present and stays
  // removed. (A value left identical to the old default is upgraded too — see
  // PRE_V1_DEFAULT_RATES for why that's acceptable.)
  if (from < 1 && isPlainObject(out.cost) && isPlainObject(out.cost.rates)) {
    for (const model of Object.keys(PRE_V1_DEFAULT_RATES)) {
      const current = DEFAULT_CONFIG.cost.rates[model];
      const saved = out.cost.rates[model];
      if (current && isPlainObject(saved) && ratesEqual(saved, PRE_V1_DEFAULT_RATES[model]) && !ratesEqual(saved, current)) {
        out.cost.rates[model] = clone(current);
      }
    }
  }
  out.configVersion = CONFIG_VERSION;
  return { config: out, changed: true };
}

// ---- read / write ------------------------------------------------------

// Deep-merge DEFAULT_CONFIG <- on-disk json, coercing/normalizing via
// validateConfig. Never throws: a missing or malformed file yields defaults.
// Runs one-time schema migrations and persists them once (see migrateRawConfig).
function readConfig() {
  let disk = null;
  try {
    disk = JSON.parse(fs.readFileSync(paths.configPath(), 'utf8'));
  } catch (_e) {
    disk = null;
  }
  if (!isPlainObject(disk)) return clone(DEFAULT_CONFIG);

  const { config: migrated, changed } = migrateRawConfig(disk);
  if (changed) {
    // Persist the migration once so it's durable and the version stamp keeps it
    // from re-running. Write the migrated RAW object — NOT the validated,
    // default-filled config — so the file keeps its minimal shape: fields the
    // user omitted still inherit live DEFAULT_CONFIG on later boots (a future
    // default change still reaches them) and any hand-added fields survive; only
    // the migrated rate(s) + the version stamp change. Best-effort — a write
    // failure (read-only FS) leaves the in-memory correction intact and it
    // re-attempts next boot.
    try {
      atomicWriteConfigFile(migrated);
    } catch (_e) {
      /* keep the in-memory migrated config */
    }
  }
  return validateConfig(migrated).config;
}

// Atomically persist an object to the config file (tmp write + same-dir rename).
// Throws on I/O failure; callers decide whether that's fatal.
function atomicWriteConfigFile(obj) {
  paths.ensureDirs();
  const file = paths.configPath();
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

// Validate, then atomically persist the full validated config.
function writeConfig(input) {
  const { valid, errors, config } = validateConfig(input);
  if (!valid) return { ok: false, errors };
  try {
    atomicWriteConfigFile(config);
    return { ok: true, config };
  } catch (e) {
    return { ok: false, errors: [String((e && e.message) || e)] };
  }
}

module.exports = {
  DEFAULT_CONFIG,
  CONFIG_VERSION,
  readConfig,
  writeConfig,
  validateConfig,
  migrateRawConfig,
  mergeConfig,
};
