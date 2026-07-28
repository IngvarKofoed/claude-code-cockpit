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

// Normalize the statusline's `context_window` ({ used_percentage, total_input_tokens,
// total_output_tokens }) into { usedPct, tokens }, or null when there is no usable
// percentage. usedPct is coerced to a finite number clamped to [0,100] (else the whole
// window is null — the gauge shows nothing rather than a wrong 0%). `tokens` sums the
// two counts, keeping whichever are finite; when NEITHER is it stays null (unknown, not
// zero) so the label degrades to "—" instead of claiming an empty context.
//
// Unlike a rate-limit window this carries no resets_at: a context window doesn't expire
// on a clock, it is replaced when the session compacts.
function normalizeContextWindow(cw) {
  if (!cw || typeof cw !== 'object') return null;
  const pct = Number(cw.used_percentage);
  if (!Number.isFinite(pct)) return null;
  const usedPct = pct < 0 ? 0 : pct > 100 ? 100 : pct;
  const inTok = Number(cw.total_input_tokens);
  const outTok = Number(cw.total_output_tokens);
  const hasIn = Number.isFinite(inTok);
  const hasOut = Number.isFinite(outTok);
  const tokens = hasIn || hasOut ? (hasIn ? inTok : 0) + (hasOut ? outTok : 0) : null;
  return { usedPct, tokens };
}

// The pushing session's id, validated to a non-empty string or null. It rides on every
// push so the daemon can attribute it — to drop a rate-limit push that isn't on the
// current subscription, and to hang the context window on the right session. A
// missing/garbage id is null, which makes both paths fail open.
function pushSessionId(body) {
  if (!body || typeof body !== 'object') return null;
  return typeof body.session_id === 'string' && body.session_id !== '' ? body.session_id : null;
}

// Map a POST /internal/usage body to the two stored windows, or null to signal DROP
// (no update). A body that isn't an object, or carries no rate_limits object, is
// dropped rather than partially applied. Each window is normalized independently; one
// absent from the payload becomes null.
//
// This governs the RATE-LIMIT bars only. A body carrying just a context_window (an
// API-key session, which never has rate_limits) is null here and still valid for the
// context path — the daemon reads that separately, before this drop.
function normalizeUsage(body) {
  if (!body || typeof body !== 'object') return null;
  const rl = body.rate_limits;
  if (!rl || typeof rl !== 'object') return null;
  return {
    fiveHour: normalizeUsageWindow(rl.five_hour),
    sevenDay: normalizeUsageWindow(rl.seven_day),
    sessionId: pushSessionId(body),
  };
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

module.exports = {
  normalizeUsage,
  normalizeUsageWindow,
  normalizeContextWindow,
  pushSessionId,
  sameUsageWindows,
  applyPattern,
  subLabel,
};
