'use strict';
// PURE helpers for the statusline rate-limit usage snapshot (POST /internal/usage).
// Split out as its own module (like aggregate/transcript/repo/pricing) so the
// normalization — the highest-risk surface: seconds->ms, clamp, malformed-drop — is
// unit-testable without starting the daemon.

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
  return { fiveHour: normalizeUsageWindow(rl.five_hour), sevenDay: normalizeUsageWindow(rl.seven_day) };
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

module.exports = { normalizeUsage, normalizeUsageWindow, sameUsageWindows };
