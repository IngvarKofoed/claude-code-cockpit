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

// ---- rate-limit percentage sample buffers -----------------------------------
// Each usage bar carries a TREND ARROW comparing its recent burn rate against the rate its
// remaining budget sustains until reset, which needs a short history of that window's
// percentage. Nothing else keeps one — rateLimitUsage is a single overwritten snapshot. The
// daemon owns one buffer PER WINDOW (one writer each); these functions are pure so the
// retention and slicing rules are unit-testable, and the browser does the per-second
// arithmetic on the shipped slice (see web/app.js:slidingRate / applyTrend).

// The span each bar's arrow measures over. They differ because `used_percentage` arrives as
// an INTEGER, so a delta carries ±1 point whatever the span — and a 30-minute slice of a 5h
// window holds ~10 points at even rate while the same slice of a week holds ~0.3. Sized by
// available signal, deliberately NOT proportional to window length (equal fractions would put
// the weekly at ~17h, too laggy to lead the projected-limit clause it exists to precede).
// web/app.js:TREND_SPAN_MS mirrors this — the browser bundle is an ES module and cannot
// require this CommonJS file, so CHANGE BOTH.
const TREND_SPAN_MS = {
  fiveHour: 30 * 60 * 1000,
  sevenDay: 6 * 3600 * 1000,
};

// Per-buffer retention. `horizonMs` is how far back samples are kept — the newest entry per
// subscription BEYOND it still survives as the anchor (see pruneUsageSamples) — and
// `maxSamples` is a runaway guard only. The 5h buffer keeps a horizon well past its own span
// (an hour against 30 minutes) purely as slack, and caps far lower: its percentage resets
// every 5 hours and so ticks many times more often per day than the weekly one, which is why
// the two cannot share a horizon without the 5h series crowding out the weekly's history.
const SAMPLE_RETENTION = {
  fiveHour: { horizonMs: 60 * 60 * 1000, maxSamples: 200 },
  sevenDay: { horizonMs: TREND_SPAN_MS.sevenDay, maxSamples: 500 },
};

const USAGE_SAMPLE_MARGIN_MS = 10 * 60 * 1000; // slack past the horizon, so a full-span lookback still resolves
const USAGE_RESET_DROP_PCT = 10; // a drop this steep is a window reset, not usage aging out

// A sample's subscription, with undefined normalized to null so an API-key / pre-feature
// push (no subscription) forms one consistent bucket rather than two.
function sampleSub(s) {
  return s && s.sub != null ? s.sub : null;
}

// Drop samples past the retention horizon, keeping — PER SUBSCRIPTION — the newest entry
// outside it. That entry is the anchor a lookback measures against, and dropping it would
// break the very case it exists for: a flat stretch longer than the horizon would prune away
// the only evidence the value is flat, so the bar could never resolve an anchor again.
function pruneUsageSamples(samples, now, retention) {
  const ret = retention || SAMPLE_RETENTION.sevenDay;
  const cutoff = now - (ret.horizonMs + USAGE_SAMPLE_MARGIN_MS);
  const anchored = new Set();
  const out = [];
  for (let i = samples.length - 1; i >= 0; i--) {
    const s = samples[i];
    if (s.t >= cutoff) {
      out.push(s);
      continue;
    }
    const sub = sampleSub(s);
    if (!anchored.has(sub)) {
      anchored.add(sub);
      out.push(s);
    }
  }
  out.reverse();
  return out.length > ret.maxSamples ? out.slice(out.length - ret.maxSamples) : out;
}

// Append one { t, pct, sub } reading, returning the pruned buffer. CHANGE-ONLY: the
// statusline posts on every render, so an unchanged percentage adds nothing (which is also
// what keeps the buffer at a few dozen entries). Returns the input array untouched when
// there is nothing to record, so the caller can cheaply detect a no-op.
function appendUsageSample(samples, entry, now, retention) {
  const list = Array.isArray(samples) ? samples : [];
  if (!entry || !Number.isFinite(entry.t) || !Number.isFinite(entry.pct)) return list;
  const sub = sampleSub(entry);
  let next = list;
  // The buffer is append-ordered and subscriptions interleave, so the newest entry for
  // THIS subscription is not necessarily the tail.
  for (let i = list.length - 1; i >= 0; i--) {
    if (sampleSub(list[i]) !== sub) continue;
    if (list[i].pct === entry.pct) return list;
    if (list[i].pct - entry.pct >= USAGE_RESET_DROP_PCT) {
      // A window reset (or bad data), not the gradual decline a rolling window shows as
      // old usage ages out: every older entry describes a different window, and keeping
      // one as an anchor would report a large false delta once usage climbed again.
      next = list.filter((s) => sampleSub(s) !== sub);
    }
    break;
  }
  return pruneUsageSamples(
    next.concat([{ t: entry.t, pct: entry.pct, sub }]),
    Number.isFinite(now) ? now : entry.t,
    retention
  );
}

// The slice served to the browser: this subscription's samples inside the lookback, plus
// the single most recent one OUTSIDE it. That out-of-window entry is the anchor, and it
// rides along deliberately — the browser re-derives the rate every second, so as its clock
// advances past this frame's, the sample it needs at now-lookback moves forward through
// this array. Without it the first tick after a frame would have nothing to anchor on.
// `sub` is filtered rather than cleared on a switch (the daemon's current subscription
// flips back and forth) so the rate survives a flip instead of restarting from scratch.
function usageSampleSlice(samples, sub, now, lookbackMs) {
  if (!Array.isArray(samples) || !(lookbackMs > 0)) return [];
  const want = sub != null ? sub : null;
  const cutoff = now - lookbackMs;
  const inside = [];
  let anchor = null;
  for (const s of samples) {
    if (!s || !Number.isFinite(s.t) || !Number.isFinite(s.pct)) continue;
    if (sampleSub(s) !== want) continue;
    if (s.t > cutoff) inside.push({ t: s.t, pct: s.pct });
    else if (!anchor || s.t > anchor.t) anchor = { t: s.t, pct: s.pct };
  }
  return anchor ? [anchor].concat(inside) : inside;
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
  appendUsageSample,
  pruneUsageSamples,
  usageSampleSlice,
  applyPattern,
  subLabel,
  TREND_SPAN_MS,
  SAMPLE_RETENTION,
  USAGE_RESET_DROP_PCT,
};
