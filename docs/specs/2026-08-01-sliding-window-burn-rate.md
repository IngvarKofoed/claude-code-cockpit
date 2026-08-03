# Sliding-window burn rate for the weekly usage bar

The weekly usage bar's two readouts — the burn-rate multiplier and the
projected-limit clause — are both driven by one quantity: the average burn rate
*since the window started*. Over seven days that average is dominated by the
hours you were asleep or away, so it answers "how have I paced this week" when
what you want deep into a window is "at the rate I'm going **now**, when do I
run out". This adds an optional **sliding lookback**, chosen from a single
dropdown (2, 3, 6, 12, 24 hours, or *Week* for today's behaviour), backed by a
daemon-side buffer of `usedPct` samples that nothing currently keeps. Under a
sliding lookback the multiplier is also reframed against the budget you have
*left*, so it and the projection can no longer disagree.

## Key decisions

- **Daemon buffers samples, browser computes the rate** (extends). The daemon
  appends `{t, pct}` whenever the weekly percentage changes and ships the
  relevant slice on `/api/state`; `web/app.js` derives the rate every second in
  its existing tick loop. This is the project's standing rule for anything
  time-derived (ARCHITECTURE, *Elapsed timers*: server timestamps, client does
  the arithmetic) and it is what makes the rate visibly **decay** as you stop
  working — a server-computed rate would freeze at the last SSE frame, which
  during idle is exactly when frames stop.
- **Samples are subscription-scoped** (extends). Each entry carries the
  subscription the push belonged to (`rateLimitUsage.subscription`, already
  tracked); the daemon filters to the *current* one before shipping. Observed in
  `daemon.log`: `currentSubscription` flips between two subscriptions several
  times a day, and a delta computed across a flip would read tens of points
  negative. Filtering rather than clearing means the rate survives a flip back.
- **Under a sliding lookback only, the multiplier is reframed** (new).
  `m = rate / ((100 − used) / timeToReset)` — 1.0× means *exactly on track to
  finish the window at 100%*. Because `m > 1 ⟺ projected exhaustion lands before
  the reset`, the multiplier and the projection clause then agree by
  construction. Deliberately **not** applied to the 5h bar or to *Week*, which
  keep `usedFrac / elapsedFrac` untouched: zero blast radius for anyone who
  never opts in. The cost is that 1.0× means two different things depending on
  the bar, carried by different tooltip text — and that entry 159's wart (a
  rounded 1.0× beside a real shortfall) survives on the un-reframed bars.
- **A rate needs ≥2 points of movement, and says so when it doesn't** (new).
  `used_percentage` arrives as an **integer** (confirmed: the stored snapshot
  holds `sevenDay.usedPct: 93`, and `normalizeUsageWindow` does not round), so a
  delta carries ±1 point of quantization error regardless of lookback. Below
  Δ = 2 the relative error exceeds 50%, so instead of a number the multiplier
  slot states which of the two reasons applies — see *When it can't measure*.
  Publishing a figure that could be off by half would break the no-wrong-number
  rule that already governs the bars' `nodata` / `reset` states.
- **One config field, no migration** (reuses). `usageWeeklyLookbackHours`:
  `0 | 2 | 3 | 6 | 12 | 24`, where **0 = whole window** — the codebase's existing
  off-is-zero idiom (`autoPauseWeeklyPct`, `idleShutdownHours`). Default `0`, so
  an upgrade changes nothing until the dropdown is touched. Daemon config like
  `usagePace`, not localStorage, because the daemon needs the lookback to size
  the slice it ships. A scalar key absent from a persisted config default-fills
  from `DEFAULT_CONFIG`, so no `CONFIG_VERSION` bump.
- **The 5h bar keeps the since-reset numerator** (reuses). A 2h lookback is 40%
  of a 5h window — close enough to the whole-window average not to be worth a
  second buffer.
- **The tick is untouched** (reuses). It still marks even-burn-since-window-start.
  Under a sliding lookback the multiplier stops restating it and becomes a
  genuinely independent fact, which strengthens rather than undermines entry
  157's reason for deleting the numeric pace delta.

## Goals

- A weekly burn rate that reflects recent working intensity instead of being
  diluted by sleep and days off.
- A projected-limit clause driven by that same recent rate, so "limit in ~3h"
  means at the pace of the last N hours.
- Reversible in one click, back to today's exact behaviour.
- Never a silently wrong number — when the data can't support a rate, say why.

## Non-goals

- Changing the 5h bar's rate basis, or its multiplier's reference.
- Feeding the auto-pause pilot from a rate or a projection — it stays a
  threshold on `usedPct`.
- Persisting rates into the usage log, rollups, or History.
- Normalizing by *engaged* time rather than wall clock (see Alternatives).

## Design

### The sample buffer

A module-level `usageSamples` array in `daemon.js`, entries
`{ t: epochMs, pct: number, sub: string|null }`, appended in
`handleInternalUsage` at the point it already computes `changed` — but gated on
the **weekly** percentage specifically, since `changed` is true when either
window moves and a 5h-only push must not append a duplicate weekly sample.

Retention: prune entries older than `MAX_LOOKBACK_MS` (24 h) plus a small
margin, with a hard cap (~500 entries) as a runaway guard. With integer
percentages the real population is a few dozen — the weekly value can move at
most 100 times in a whole week.

Discontinuity: if the incoming pct is **≥10 points below** the previous sample
for the same subscription, drop every older entry for it. That is a window reset
or bad data, and a stale pre-reset anchor would otherwise produce a large false
delta. Small decreases are kept: if the 7-day window turns out to be rolling
(usage aging out) they are normal, and a negative delta simply fails the Δ gate.

Persisted in `snapshot.json` as a new top-level `usageSamples` key, restored in
`loadSnapshot` alongside `usage` — so a daemon restart doesn't cost a full
lookback of history. An absent key tolerates as an empty buffer.

### What crosses the wire

`buildStatePayload` adds `usage.sevenDay.samples` — the entries matching the
current subscription, within `[now − lookback, now]`, plus the single most
recent entry *older* than that (the anchor), with `sub` stripped. Under a 2h
lookback that is typically a handful of numbers.

The slice is deliberately anchor-inclusive: as the browser's clock advances past
the frame's, the sample it needs at `now − lookback` moves *forward* through the
shipped array, so a client tick between frames can never run off the end. A new
sample only exists when the weekly pct changed, which is exactly when a frame is
broadcast, so the client's buffer is never behind.

With `usageWeeklyLookbackHours: 0` the field is omitted entirely — no cost for
users who never enable it. Filtering a ≤500-entry array is negligible on the
broadcast path (unlike `/api/storage`, which is kept off it because it stats the
filesystem).

### The two readouts

Both currently re-derive their own rate inline. Factor that out — one function
returning percentage-points per millisecond, or `null` when unmeasurable:

```js
// lookback 0:  usedPct / (elapsedFrac(resetsAt, windowMs, now) * windowMs)
// lookback N:  (usedPct − anchorPct) / lookbackMs,
//              where anchorPct is the last sample at or before now − lookbackMs
```

Under a sliding lookback, everything downstream is:

```js
affordable = (100 − usedPct) / (resetsAt − now)   // points per ms, from here
m          = rate / affordable                    // the multiplier
leftMs     = (100 − usedPct) / rate               // the projection
```

Worked, at the author's current position — 93% of the weekly window, 3 days
left, burning ~2 points/hour:

| | rate | multiplier | projection |
|---|---|---|---|
| *Week* (unchanged) | 0.97 pts/h | 1.6× | limit in ~7h 15m |
| sliding 6h | 2.0 pts/h | 20.6× | limit in ~3h 30m |

Display: one decimal below 10×, integer above, `>99×` beyond — classified for
colour by the string actually rendered, per entry 54's rule that the number and
its colour can never disagree. The tooltip names the basis and the span
("burning 20.6× what your remaining budget sustains, measured over the last
6h"), which is where the two meanings of 1.0× are disambiguated.

`applyLimit` keeps its `paceTolerance(windowMs)` band, now expressed directly as
the shortfall it already computes (`timeToReset − leftMs ≥ tolerance`), so a
value hovering at 1.0× doesn't flicker the clause on and off. Its
`LIMIT_SETTLED_FRAC` guard is dropped under a sliding lookback — it exists
because the since-reset rate is jumpy when little of the window has elapsed,
which no longer applies; the Δ gate does that job instead.

### When it can't measure

Under a sliding lookback the multiplier slot always says something. Three states,
distinguished by whether an anchor sample exists at or before `now − lookback`:

| condition | multiplier slot | projection |
|---|---|---|
| anchor exists, Δ ≥ 2, rate > 0 | `20.6×` | rendered |
| anchor exists, Δ < 2 | `< 2%/6h` | omitted |
| no anchor (or Δ < 0) | `measuring…` | omitted |

`< 2%/6h` states the upper bound the data actually proves — under two points of
the weekly budget across the chosen span. Deliberately not "no recent burn",
which would overclaim: a Δ of 1 could be anything up to 1.9 real points, which
at 93% used is a meaningful share of what's left.

`measuring…` covers every case where history simply doesn't reach back far
enough yet — a fresh daemon with no snapshot, the minutes after a subscription
switch, or a lookback longer than the daemon has been collecting. It resolves on
its own, and saying so beats an empty slot the user reads as broken.

Both are muted, sized like the multiplier, and must not read as a warning. The
bar keeps its fill, tick, percentage and countdown throughout, so these states
stay visibly distinct from the `nodata` shell ("awaiting data…") and from a
stale bar's age note. With `Week` selected, today's guards and blank behaviour
are unchanged — the messages are scoped to the sliding path so the 5h bar is
untouched.

Known and accepted: near the cap the 1-point quantum is a large slice of the
remaining budget, so the multiplier's *precision* degrades exactly where it
matters most. A ±1-point delta error at 93% used with 7 points left is worth
several × on the ratio. The projection inherits the same relative error — which
is why it is prefixed `~`, and why longer lookbacks are more trustworthy.

### Settings

One row in Settings ▸ Dashboard, directly under *Usage pace cue*: a select
labelled **Weekly burn rate**, options *Week (since reset)* · *Last 2 hours* ·
*3* · *6* · *12* · *24 hours*, description naming the tradeoff (a shorter span
tracks current intensity; a longer one is steadier and blanks less often).
Merging the on/off switch into the same control keeps it a single decision —
there is no state where a switch and a span disagree.

`validateConfig` rejects a value outside the six, matching how `usagePace` and
`activityDetail` are validated. `PUT /api/config` already pushes a fresh state
frame (entry 69), so changing the span re-slices the shipped samples
immediately.

### Verification

`scripts/usage.test.js` covers the pure buffer functions — append/dedupe, age
and cap pruning, the ≥10-point discontinuity drop, subscription filtering, and
the shipped-slice boundaries including the anchor. The client-side rate math has
no test framework (`web/` deliberately has none) and is verified in the browser
per `web/CLAUDE.md`, like every existing pace readout. The three
can't-measure states are reachable on demand by selecting a span longer than the
daemon's buffer.

## Alternatives considered

- **Reframe the multiplier everywhere** — one meaning of 1.0× across the page,
  at the cost of changing a visible number (1.6× → 10.0× on the current weekly
  bar) for users who never enable the feature. Rejected in favour of zero blast
  radius; the price is two meanings of 1.0×, separated by tooltip.
- **Normalize by engaged time** — divide by the active time inside the lookback
  (the event log's engaged clock) instead of wall clock, giving "burn per hour of
  work". Sleep can't dilute it at all, but converting back to a wall-clock
  projection needs an assumption about future working hours, which is a guess the
  cockpit has no basis for. Parked, not rejected.
- **Daemon computes the rate and ships a scalar** — smaller payload, and the
  math would be unit-testable in `usage.js`. Rejected: the rate would only
  refresh on an SSE frame, so it would freeze precisely when you stopped working,
  killing the decay that is the feature's entire point.
- **Auto-widen the span when the lookback is too coarse** — always show a number
  by reaching further back until 2 points of movement are covered. Rejected: "2h"
  would silently mean "the last 5h", turning the setting into a floor rather than
  a promise. The `< 2%/6h` message says the same thing honestly.
- **A separate on/off switch plus a span select** — the original shape. Rejected
  as two controls for one decision, with a dead state (span set, switch off).
