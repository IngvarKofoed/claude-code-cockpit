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
const CONFIG_VERSION = 3;

// The spans the weekly bar's burn-rate readouts may measure over (0 = the whole window).
// validateConfig is the authority. The Settings dropdown MIRRORS this list rather than
// sharing it (web/app.js:WEEKLY_LOOKBACK_OPTIONS) — the dashboard is a buildless browser
// module and cannot require a CommonJS file, and no endpoint serves the schema — so adding
// a span here does not reach the UI on its own. Change both.
const USAGE_WEEKLY_LOOKBACK_HOURS = [0, 2, 3, 6, 12, 24];

const DEFAULT_CONFIG = {
  configVersion: CONFIG_VERSION,
  port: 4319,
  osNotifications: true,
  sound: true,
  browserSounds: true,
  activityDetail: 'tool', // 'tool' | 'args'
  usagePace: 'both', // 'both' | 'tick' | 'delta' | 'off' — Live usage-bar pace cue
  // Span the WEEKLY usage bar's burn-rate readouts measure over, in hours. 0 = the whole
  // window (average since it opened) — today's behaviour and the default, so an upgrade
  // changes nothing until the dropdown is touched. A positive value switches that bar's
  // multiplier and projected-limit clause to a sliding lookback, which excludes the sleep
  // and idle hours a seven-day average is dominated by. Off-is-zero matches the
  // autoPauseWeeklyPct / idleShutdownHours idiom rather than adding a second on/off field.
  usageWeeklyLookbackHours: 0,
  // Regex SOURCE string applied to a subscription's raw name to extract a clean
  // display label (see usage.subLabel/applyPattern). Default pulls the first
  // parenthesized group's contents, so "FOSS Analytical (Lyra)" renders as "Lyra";
  // a name without parens simply doesn't match and falls back unchanged. '' = off
  // (identity). Applied at payload-build time only — never migrates stored data.
  subscriptionLabelPattern: '\\(([^)]+)\\)',
  events: { sessionFinished: true, needsInput: true, longRunning: false, turnFailed: true, safeToClose: true },
  longRunningThresholdMs: 300000,
  // Pause gate: master switch (default ON) + usage auto-pilot. autoPauseFiveHourPct /
  // autoPauseWeeklyPct are the 5h and 7-day rate-limit thresholds that auto-pause
  // (0 = off; either one crossing pauses, both must fall back below their resume line to
  // auto-resume). The 5h default is 90; the WEEKLY one ships OFF (0) on purpose — the 7-day
  // window only falls back below its resume line as old usage ages out, so a weekly
  // auto-pause can hold for days, which is too heavy to impose by default. There is
  // deliberately NO migration (a boolean can't tell a deliberate opt-out from the old
  // default): a persisted explicit `false` stays off, but the on-by-default reaches any
  // config that merely OMITS the key — a fresh/config-less install OR an existing
  // minimal/hand-edited/migrated config.json — since both the daemon's merged config and
  // the gate hook (see pause.js) fill an absent key from here.
  pauseGateEnabled: true,
  autoPauseFiveHourPct: 90,
  autoPauseWeeklyPct: 0,
  cost: {
    enabled: true,
    currency: 'USD',
    rates: {
      // USD per 1,000,000 tokens. cacheWrite is the 5-minute-TTL cache-write rate
      // (1.25x input) and cacheWrite1h the 1-hour one (2x input); cacheRead is 0.1x
      // input. Both TTLs occur in normal Claude Code use — roughly 40% of cache
      // writes are 1h — so pricing them at one rate materially understates cost.
      // cacheWrite1h is OPTIONAL in a rate and falls back to cacheWrite (see
      // pricing.RATE_FALLBACK), which is what keeps an older saved map working.
      'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
      'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5, cacheWrite1h: 20 },
      // Opus 5 prices at the Opus 4.5+ tier, and its 1M context is the default
      // with no long-context premium — so the "[1m]" variant id bills the same
      // (priced via pricing.js's base-id fallback, not a second entry here).
      // Fast mode ($10/$50) is NOT distinguishable from the model id, so a
      // fast-mode turn is under-estimated; accepted (no local signal for it).
      'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
      'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
      'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
      'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
      'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25, cacheWrite1h: 10 },
      // Sonnet 5 has an intro rate of $2/$10 through 2026-08-31; this is the
      // standard post-intro rate it reverts to (see docs/CHANGELOG.md).
      'claude-sonnet-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25, cacheWrite1h: 2 },
      // Deprecated / retired tiers, kept so BACKFILL of an old transcript prices
      // rather than showing "—". A dated snapshot id (claude-opus-4-1-20250805)
      // resolves here via pricing.js's base-id fallback, which is also why the
      // retired Haiku 3.5 is keyed by its base id — it never had a dotless alias.
      'claude-opus-4-1': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
      'claude-opus-4-0': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75, cacheWrite1h: 30 },
      'claude-sonnet-4-0': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75, cacheWrite1h: 6 },
      'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1, cacheWrite1h: 1.6 },
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

// Rate keys that FIRST shipped as defaults in configVersion 2. A persisted
// `rates` map REPLACES the defaults (see validateConfig), so a user who saved
// Settings before these models existed would price them as "—" forever. Adding
// them back is safe precisely because they were never in an earlier shipped
// default: their absence cannot be a deliberate Settings removal (unlike
// claude-opus-4-8, which is why the v0->v1 step never re-adds a missing key).
const RATE_MODELS_ADDED_IN_V2 = [
  'claude-opus-5',
  'claude-mythos-5',
  'claude-opus-4-1',
  'claude-opus-4-0',
  'claude-sonnet-4-0',
  'claude-3-5-haiku',
];
deepFreeze(RATE_MODELS_ADDED_IN_V2);

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

// The four classes a rate must define, and the optional ones it may. An optional
// class that is absent (or unparseable) is OMITTED from the result rather than
// defaulted, so pricing.js applies its documented fallback (cacheWrite1h ->
// cacheWrite) instead of a silent 0 — a 0 would price 1-hour cache writes free.
const REQUIRED_RATE_KEYS = ['input', 'output', 'cacheRead', 'cacheWrite'];
const OPTIONAL_RATE_KEYS = ['cacheWrite1h'];

function validateRate(r) {
  if (!isPlainObject(r)) return null;
  const out = {};
  for (const k of REQUIRED_RATE_KEYS) {
    const n = toNum(r[k]);
    if (n === null) return null;
    out[k] = clampMin(n, 0); // negative money rates are nonsensical
  }
  for (const k of OPTIONAL_RATE_KEYS) {
    const n = toNum(r[k]);
    if (n !== null) out[k] = clampMin(n, 0);
  }
  return out;
}

// Deep-equality for a rate entry, tolerant of numeric strings (a hand-edited
// config may quote numbers), comparing only the four REQUIRED token classes —
// migrations use this to recognize an untouched shipped default, and a rate
// predating an optional class must still match the default it came from.
function ratesEqual(a, b) {
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  for (const k of REQUIRED_RATE_KEYS) {
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

  // Only the spans the Settings dropdown offers; anything else is rejected rather than
  // clamped, so a hand-edited config can't quietly become a span the UI can't display.
  if ('usageWeeklyLookbackHours' in input) {
    // A numeric string coerces, like `port` — but null / '' / a boolean must NOT: Number()
    // maps all three to 0, which would silently read as a deliberate "whole window" rather
    // than the malformed value it is.
    const raw = input.usageWeeklyLookbackHours;
    const h = typeof raw === 'number' || (typeof raw === 'string' && raw.trim() !== '') ? Number(raw) : NaN;
    if (USAGE_WEEKLY_LOOKBACK_HOURS.includes(h)) {
      cfg.usageWeeklyLookbackHours = h;
    } else {
      errors.push('usageWeeklyLookbackHours must be one of ' + USAGE_WEEKLY_LOOKBACK_HOURS.join(', '));
    }
  }

  // Must compile as a RegExp; a value that doesn't is rejected (leaving the on-disk
  // config untouched, per the validate discipline) so a bad pattern can never be
  // persisted. '' is allowed and means identity (extraction off).
  if ('subscriptionLabelPattern' in input) {
    const p = input.subscriptionLabelPattern;
    if (typeof p !== 'string') {
      errors.push('subscriptionLabelPattern must be a string');
    } else if (p === '') {
      cfg.subscriptionLabelPattern = '';
    } else {
      try {
        new RegExp(p);
        cfg.subscriptionLabelPattern = p;
      } catch (_e) {
        errors.push('subscriptionLabelPattern must be a valid regular expression');
      }
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

  // Usage auto-pilot thresholds (per rate-limit window): a percentage clamped to [0,100] (0 = off).
  for (const key of ['autoPauseFiveHourPct', 'autoPauseWeeklyPct']) {
    if (key in input) {
      const n = toNum(input[key]);
      if (n === null) errors.push(`${key} must be a number`);
      else cfg[key] = Math.min(100, clampMin(n, 0));
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
  // v1 -> v2: add rate entries for models that first shipped as defaults in v2
  // (see RATE_MODELS_ADDED_IN_V2 for why re-adding these can't undo a delete).
  // An entry the user already has — at any value — is left untouched.
  if (from < 2 && isPlainObject(out.cost) && isPlainObject(out.cost.rates)) {
    for (const model of RATE_MODELS_ADDED_IN_V2) {
      const current = DEFAULT_CONFIG.cost.rates[model];
      if (current && !(model in out.cost.rates)) out.cost.rates[model] = clone(current);
    }
  }
  // v2 -> v3: fill in the new cacheWrite1h (1-hour cache-write) rate — but ONLY on
  // an entry whose four required classes still equal the current shipped default,
  // i.e. one the user never edited. A CUSTOMIZED rate is left alone on purpose: its
  // cacheWrite then governs both TTLs via pricing's fallback, which is exactly what
  // that rate meant when it was saved. Injecting 2x-input there would silently
  // re-price someone's deliberate number.
  if (from < 3 && isPlainObject(out.cost) && isPlainObject(out.cost.rates)) {
    for (const model of Object.keys(out.cost.rates)) {
      const current = DEFAULT_CONFIG.cost.rates[model];
      const saved = out.cost.rates[model];
      if (!current || current.cacheWrite1h == null) continue; // no default 1h rate to apply
      if (!isPlainObject(saved) || saved.cacheWrite1h != null) continue; // absent only
      if (ratesEqual(saved, current)) saved.cacheWrite1h = current.cacheWrite1h;
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
  USAGE_WEEKLY_LOOKBACK_HOURS,
  readConfig,
  writeConfig,
  validateConfig,
  migrateRawConfig,
  mergeConfig,
};
