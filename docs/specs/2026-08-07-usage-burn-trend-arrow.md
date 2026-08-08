# Burn-rate trend arrow on the Live usage bars

Add a single ▲/▼ glyph after each usage bar's burn-rate multiplier, driven by the last
30 minutes (5h bar) or 6 hours (weekly bar) of statusline samples, comparing that recent
rate against the rate the *remaining* budget sustains until reset. It replaces
`usageWeeklyLookbackHours` and its sliding multiplier/limit paths
(`docs/specs/2026-08-01-sliding-window-burn-rate.md`, changelog 161–170), which shipped but
went unused: they swapped a number the user trusted for one that frequently refused to read.
The sign of that same computation survives the data's precision limits where its magnitude
does not, so this keeps the computation and throws away the display that broke.

## Key decisions

- **A direction, never a magnitude** (new). One glyph, no second number. Entry 157 removed
  the pace delta because three renderings of one relationship read as three facts; the same
  restraint applies here. A sign also survives the ±1 point quantization of an integer
  `used_percentage`, which is precisely what made the sliding *number* fragile.
- **Additive, not a replacement** (diverges). The existing multiplier and projected-limit
  clause are untouched in meaning and gating. The predecessor's mistake was substituting
  itself for the stable reading; an absent glyph is a fine state, a `measuring…` where a
  number belongs is not.
- **Affordable-rate baseline, on both bars** (reuses). `affordableRate()` — `(100 − pct) /
  (resetsAt − now)` — survives the removal and becomes the arrow's reference on *both*
  windows. Rejected alternative: comparing against each window's own average, which is
  pinned ▲ every working hour on the weekly bar (a 7-day average includes sleep). One
  baseline also means one meaning for the glyph, avoiding entry 164's "1.0× means two
  things depending on the bar".
- **Per-window spans, hardcoded** (new). 30 min on the 5h bar, 6h on the weekly. Sized by
  how much signal each series produces, deliberately *not* proportional to window length.
  Not configurable — the dropdown this replaces is the one the user never touched.
- **A second sample buffer for the 5h series** (extends). `usageSamples5h` alongside the
  existing weekly `usageSamples`, with its own ~1h retention; `pruneUsageSamples` gains a
  horizon parameter. Chosen over generalizing the buffer into a per-window map, which is
  tidier but changes the snapshot shape for no behavioural gain.
- **Client-derived, every second** (reuses). The daemon ships a sample slice per window and
  `app.js` derives rate and direction in the existing tick loop. Both denominators must move
  between pushes: the affordable rate rises as the reset nears, and the recent-rate window
  slides, so an idle session decays to ▼ on its own (the entry-46 drift-don't-freeze rule).
  Known cost: `web/` has no test framework by rule and cannot `require` the CommonJS
  `usage.js` (`config.js:20`), so the threshold logic is untestable — accepted because it is
  ~20 lines over the already-tested `slidingRate`.
- **`slidingRate` returns a signed rate** (breaking, internal). It currently collapses a
  negative or sub-threshold delta to `{rate: null, why: 'declining'|'coarse'}`; those two
  states existed only to render text. It now returns `{rate, points, spanMs, partial}` where
  `points` is the raw signed delta (`pct − base.pct`) and `rate` is `points / spanMs`, and
  the caller gates. A falling weekly percentage is a real ▼ ("recovering headroom faster than
  you spend"), not an absence of data. `rate` is still `null` in the two cases that are
  genuinely no-data — no usable base sample, or a span under `MIN_SPAN_MS` — so callers keep
  a null check; only the `why` strings and their two null-states disappear.
- **`usageWeeklyLookbackHours` removed** (breaking). Config key, the
  `USAGE_WEEKLY_LOOKBACK_HOURS` option set, its validation branch, and the Settings dropdown
  all go. A persisted key goes inert as an unknown key to `validateConfig` — entry 27's
  precedent for `retentionDays` — so no migration is written.

## Goals

- Give both bars a leading indicator: *is my recent pace heading over this window's limit
  before it resets?* — ahead of the whole-window average, which lags by construction.
- Keep the stable multiplier and limit clause exactly as they read today.
- Retire the sliding-lookback feature and the conditional code it threaded through
  `applyMult` / `applyLimit` / `bindUsage`.

## Non-goals

- Configurable spans, or any new Settings control.
- Changing the whole-window multiplier's meaning, or the limit clause's gating.
- New statusline or forwarder fields — the same `rate_limits` payload feeds this.
- A recent-rate *number* anywhere on the bar.

## Design

### Spans, and why they differ

`used_percentage` arrives as an integer, so any delta carries ±1 point. What differs
between the windows is how many points a given span contains:

| bar | span | % of window | points at even rate | quantization error |
|---|---|---|---|---|
| 5h | 30 min | 10% | ~10 | ±10% |
| weekly | 6h | 3.6% | ~3.6 | ±28% |

30 min on the 5h bar: 15 min would be ~5 points and short enough for one large turn to
dominate; 1h is 20% into the window and lags, and the 5h window is the one that auto-pauses
at 90%, so lead time is the whole value. 6h on the weekly: 3h yields ~1.8 points (±55%,
below the data's resolution); 12h is steadier but turns over only twice a day, by which
point the existing limit clause has already said the same thing. Both spans are most precise
exactly when they matter — near the cap you are burning above even rate, so the real point
count is higher than the table's.

Equal *fractions* would put the weekly at ~17h, too laggy to be a signal at all. The spans
are sized by available signal, not symmetry.

### Sampling the 5h series

`handleInternalUsage` (`daemon.js:2388`) currently appends only `windows.sevenDay.usedPct`.
It gains a sibling append for `windows.fiveHour.usedPct` into `usageSamples5h`, under the
same rules already established for the weekly buffer:

- change-only (the forwarder posts on every statusline render);
- tagged with the **pushing session's** subscription, never the current-subscription
  fallback (entry 167 — a sample is read back a full span later, so an unknown-subscription
  push must land in the null bucket rather than leak into a real account's history);
- a drop of ≥ `USAGE_RESET_DROP_PCT` discards that subscription's history.

That last rule already handles the 5h reset (≈80 → 0 trips it), at the accepted cost of no
arrow for the first 30 min of each 5h window. Retention is ~1h + the existing margin, and
the per-buffer cap drops accordingly (~200) — the 5h percentage can tick far more often per
day than the weekly one, so sharing the 24h horizon would blow `USAGE_MAX_SAMPLES`.

`pruneUsageSamples(samples, now)` becomes `pruneUsageSamples(samples, now, horizonMs)`; the
per-subscription out-of-horizon anchor rule is unchanged and applies to both buffers.

`usageSamples5h` is snapshot-persisted and restored exactly as `usageSamples` is
(`daemon.js:437` / `:3132`), each restore pruning against its own horizon. Persisting a ~1h
buffer is nearly free and is what stops every daemon restart from costing the 5h bar its
arrow for a full 30 minutes — the same reasoning that persists the weekly one. Losing it is
survivable either way: the buffer rebuilds from the next pushes, and a missing arrow is an
already-supported state.

### Payload

`usagePayload(now)` loses its `hours > 0` gate and attaches a `samples` slice to **both**
windows unconditionally: 6h + anchor for the weekly, 30 min + anchor for the 5h. Each slice
goes through the existing `usageSampleSlice`, so both are filtered to
`rateLimitUsage.subscription` by the same rule — a switch hides the other account's history
rather than clearing it, and a flip back recovers it (entry 163). Expected
size is a few dozen entries total — the weekly percentage ticks a handful of times in 6h,
the 5h percentage tens of times in 30 min. This now rides every SSE broadcast rather than
only when a user opted in, which is the one throughput consequence worth watching; keeping
the slices span-tight (rather than shipping the whole buffer) is what bounds it.

### Deriving the arrow

Per bar, each second, alongside `applyMult` / `applyLimit`:

```js
// trendMs is the per-bar span: TREND_SPAN_MS.fiveHour (30 min) / .sevenDay (6h)
const { rate, points } = slidingRate(w, pct, now, trendMs);           // rate is signed
if (pct >= 100 || rate == null || Math.abs(points) < MIN_RATE_POINTS) return; // no glyph
const afford = affordableRate(pct, w.resetsAt, now);
if (afford == null || !(afford > 0)) return;                          // no glyph
const ratio = rate / afford;
if (ratio > 1 + TREND_BAND) → ▲   else if (ratio < 1 - TREND_BAND) → ▼   else no glyph
```

`TREND_BAND = 0.15`, so a ratio hovering at 1.0 doesn't blink the glyph on and off.

Notable edges, all falling out of the above rather than needing special cases:

- **A negative rate** (weekly usage aging out faster than it accrues) gives a negative
  ratio, which is `< 1 − BAND` → ▼. Correct, and the case the predecessor refused to read.
- **`MIN_SPAN_MS` (30 min) still bounds a partial span.** For the 5h bar that equals the
  full span, so its arrow simply waits for 30 min of buffer and `partial` never applies.
  For the weekly, a partial span between 30 min and 6h is allowed but must still clear 2
  points — which at 30 min means a very hot burn, so the gate is self-limiting.
- **Within the band and "can't measure yet" render identically — nothing.** Both correctly
  mean "don't act on this", and the multiplier's own colour already carries an on-pace
  verdict, so a third neutral glyph would occupy the line permanently to distinguish two
  states that call for the same response. The tooltip on the multiplier says which it is.
- **At the cap** the multiplier's "at limit" remains the sole exhausted-state cue.
- **On a stale bar** the arrow keeps drifting with everything else (entry 46), since the
  slice ages out from under it and the rate decays toward 0.

### Rendering

A `<span class="usage-bar__trend">` inside `.usage-bar__foot`, after `.usage-bar__mult` —
which keeps its `margin-left: auto` (entry 158), so the pair sits right-aligned as
`2.1× ▲`. `:empty { display: none }` handles every no-glyph path. Coloured with the
multiplier's own verdict tokens (`--st-waiting` for ▲, `--st-running` for ▼) rather than
muted: the divergence from the number beside it is the entire point, and a muted glyph among
coloured numbers gets ignored.

That means a muted `1.0×` can sit beside an amber `▲` — the *average* is fine while the
recent pace is not. This is entry 159's accepted precision-not-contradiction trade, now
expressed in colour, and it is the intended reading rather than a defect; the tooltip names
the span it measured over.

The arrow rides `showReadout` (`usagePace` of `both` / `delta`) with the multiplier and the
limit clause, so one setting still governs the whole foot.

It also complements the limit clause rather than restating it: that clause fires off the
whole-window rate, this off the recent one. ▲ with no clause is "your average is still fine
but you've just stepped up"; both together is confirmation; the clause beside ▼ is "behind,
but recovering".

### What comes out

`usageWeeklyLookbackMs`, `WEEKLY_LOOKBACK_OPTIONS`, `applyMultSliding`, `applyLimitSliding`,
the `lookbackMs` parameter threaded through `applyMult` / `applyLimit` / `bindUsage`, the
Settings dropdown and its save entry, and the `.usage-bar__mult--none` / `.usage-bar__mult-span`
styles. `fmtSpan` survives for the tooltip; `slidingRate`, `affordableRate`, `MIN_RATE_POINTS`
and `MIN_SPAN_MS` survive as the arrow's machinery.

`docs/ARCHITECTURE.md`'s *Rate-limit usage bars* section documents the sliding lookback at
length, including the `usageWeeklyLookbackHours` entry in its Configuration block. Both
become wrong on this change and must be rewritten, not appended to.

## Alternatives considered

- **Recent rate vs. each window's own average.** The natural reading of a glyph attached to
  a number ("2.1×, and rising"), and it works on the 5h bar. Rejected because the weekly
  average includes every hour you were asleep, pinning that arrow ▲ for the whole working
  day at any span — a constant carries no information.
- **Server-derived verdict.** The daemon computes the direction and ships `trend:
  'over'|'under'|null`; tiny payload, and the sample-selection logic lands in `usage.js`
  where it is unit-testable. Rejected because the arrow would freeze between statusline
  pushes — and pushes stop entirely when you stop working, which is exactly when it should
  be decaying to ▼. Faking the drift needs a daemon timer.
- **Keeping `usageWeeklyLookbackHours` alongside the arrow.** Two overlapping recent-rate
  features on one bar, one of them already known unused.
- **Tick-interval estimation** (`K points / (t_last − t_{last−K})`) for the weekly rate,
  which has no numerator quantization at all and degrades honestly at low burn. A genuinely
  better estimator, deferred: reducing the output to a sign already absorbs the error a 6h
  span carries, so it would buy precision the display no longer spends.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Single agent, Opus 5.** Seven files, but one code path: the additions and removals are
  interleaved on the same functions (`applyTrend` lands beside `applyMult` while `lookbackMs`
  comes out of it), so splitting streams would mean two agents editing `web/app.js`.
- The judgment is concentrated in the `(breaking, internal)` `slidingRate` change — which
  null-states survive and which go — and in the removal sweep. Neither is transcription, so
  don't drop the tier.
- Finish in the same session with the `web/CLAUDE.md` browser pass (Playwright against a
  live daemon): the arrow's gates are time- and sample-dependent, and `node --test` covers
  `usage.js` but nothing in `web/`.
