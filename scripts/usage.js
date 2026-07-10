'use strict';
// PURE helpers for the statusline rate-limit usage snapshot (POST /internal/usage).
// Split out as its own module (like aggregate/transcript/repo/pricing) so the
// normalization — the highest-risk surface: seconds->ms, clamp, malformed-drop — is
// unit-testable without starting the daemon.
//
// It also owns the subscription-LABEL transform (applyPattern / subLabel): turning a
// stored raw subscription base name into a display label via the configurable
// subscriptionLabelPattern regex, applied at payload-build time only (never at capture
// or in storage), so a pattern change re-labels every surface without touching data.

const { subBaseName } = require('./aggregate');

// Normalize one statusline rate-limit window ({ used_percentage, resets_at } in
// SECONDS) into { usedPct, resetsAt } (resetsAt in MILLISECONDS), or null. usedPct is
// coerced to a finite number clamped to [0,100] (else the whole window is null).
// resetsAt must be a positive finite number, else the window keeps usedPct with
// resetsAt=null (the bar then renders without a tick/countdown).
function normalizeUsageWindow(w) {
  if (!w || typeof w !== 'object') return null;
  const pct = Number(w.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const usedPct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  const secs = Number(w.resets_at);
  const resetsAt = Number.isFinite(secs) && secs > 0 ? secs * 1000 : null;
  return { usedPct, resetsAt };
}

// Map a POST /internal/usage body to the two stored windows, or null to signal DROP
// (no update). A body that isn't an object, or carries no rate_limits object, is
// dropped rather than partially applied. Each window is normalized independently; one
// absent from the payload becomes null.
function normalizeUsage(body) {
  if (!body || typeof body !== 'object') return null;
  const rl = body.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  // session_id rides on the push so the daemon can look up the pushing session's
  // subscription and drop a push that isn't on the current one. Validated to a
  // non-empty string or null (a missing/garbage id is null → the drop fails open).
  const sessionId = typeof body.session_id === 'string' && body.session_id !== '' ? body.session_id : null;
  return { fiveHour: normalizeUsageWindow(rl.five_hour), sevenDay: normalizeUsageWindow(rl.seven_day), sessionId };
}

function sameWindow(x, y) {
  if (x == null || y == null) return x == null && y == null;
  return x.usedPct === y.usedPct && x.resetsAt === y.resetsAt;
}

// True when two snapshots carry the SAME rate-limit numbers (ignoring updatedAt), so the
// daemon can skip an SSE broadcast when a forwarder push didn't actually change the bars —
// the statusline posts frequently and every broadcast rebuilds the whole Live card grid.
function sameUsageWindows(a, b) {
  if (!a || !b) return false;
  return sameWindow(a.fiveHour, b.fiveHour) && sameWindow(a.sevenDay, b.sevenDay);
}

// Extract a display label from a subscription name via a regex SOURCE string.
// Compiles `pattern`, runs it against `name`, and returns capture group 1 when the
// pattern has one (else the whole match). On NO match, an empty/non-string pattern,
// an empty extraction, or ANY throw (a bad pattern) it returns `name` UNCHANGED — so a
// label is never blank and a malformed pattern can't break the UI. Pure + total.
// e.g. applyPattern('FOSS Analytical (Lyra)', '\\(([^)]+)\\)') === 'Lyra'.
function applyPattern(name, pattern) {
  if (typeof name !== 'string') return name;
  if (typeof pattern !== 'string' || pattern === '') return name;
  try {
    const m = new RegExp(pattern).exec(name);
    if (!m) return name;
    const extracted = m[1] != null ? m[1] : m[0];
    return typeof extracted === 'string' && extracted !== '' ? extracted : name;
  } catch (_e) {
    return name;
  }
}

// The display label for a subscription: the stored raw base name (subBaseName) with
// cfg.subscriptionLabelPattern applied. Applied at payload-build time only, so a
// pattern change re-labels history retroactively and no stored record holds the
// patterned label. A missing/blank pattern is identity (extraction off).
function subLabel(sub, cfg) {
  const base = subBaseName(sub);
  const pattern = cfg && typeof cfg.subscriptionLabelPattern === 'string' ? cfg.subscriptionLabelPattern : '';
  return applyPattern(base, pattern);
}

module.exports = { normalizeUsage, normalizeUsageWindow, sameUsageWindows, applyPattern, subLabel };
