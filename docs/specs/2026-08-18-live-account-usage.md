# Live-account usage: fix the stale-subscription drop guard

The rate-limit usage path attributes every statusline push to the pushing session's
subscription **as captured once at SessionStart** — but the account is a single global
`oauthAccount` in `~/.claude.json`, so a mid-day account switch moves every running session
onto the new account while their captured labels stay behind. The label-based drop guard in
`handleInternalUsage` then discards the *correct* readings as "stale non-current pushes"
(216 drops on 2026-08-18 alone), starving both the usage bars and the auto-pause pilot —
a 95% reading arrived and the gate never armed, because `evalAutoPause` sits after the
drop's `return`. This spec replaces account-identity filtering with two things that are
actually true of the data: **the live account** (read by the daemon from `~/.claude.json`,
mtime-cached) and **reading freshness** (a push is only as fresh as its session's last API
activity). Every prior fix in this area (changelog 42, 66, 74, 86, 88, 163, 167) patched
around the captured-label assumption; this removes the assumption.

## Key decisions

- **The daemon reads the live account itself** (extends). `emit.js`'s `readSubscription()` /
  `claudeConfigPath()` move to a shared module (`scripts/account.js`) required by both
  `emit.js` and `daemon.js`; the daemon wraps it in an mtime cache (`statSync` per use,
  re-parse only on change). Second reader of a file we already depend on; fails open to
  `null` on any read/parse error.
- **The label drop guard is deleted, replaced by a freshness guard** (diverges, from entry
  66's design). A push to the bars is accepted iff its reading (a) postdates the current
  account's start (`liveAccountSince`) and (b) is at least as fresh as the accepted
  snapshot's. Freshness = the pushing session's `lastActivityAt` — an event-derived proxy
  for reading age, with two known edges named in Design. Both checks fail-open when a
  side is unknown (entry 42's rule: never worse than last-write-wins).
- **The guard is a pure function in `scripts/usage.js`** (reuses). `acceptUsagePush({...})
  → { accept, reason }`, unit-tested like `normalizeUsage`/`appendUsageSample`; the daemon
  supplies the inputs and obeys the verdict.
- **`evalAutoPause` moves ahead of any silent discard** (extends). It runs on every push
  that passes the freshness guard — which is every *correct* reading, so the gate can no
  longer be starved. Genuinely stale readings still don't drive the gate.
- **Snapshot, samples, and the ribbon tile are attributed to the live account** (breaking,
  vs the captured-label semantics). `rateLimitUsage.subscription`, sample `sub` tags, and
  the Live ribbon's Subscription tile all carry `liveAccount.id`; `aggregate.
  currentSubscription` (newest-*started* live session) survives only as the fallback when
  the file is unreadable. No sample migration — old tags mostly coincide, worst case a
  wrong trend anchor for ≤6h after upgrade.
- **Live-turn token attribution uses the account at ingest time** (extends). The usage
  record written at Stop for the *just-closed* turn takes `liveAccount` (falling back to
  the captured sub); earlier-day backfill groups and `/cockpit:backfill` keep their current
  attribution (captured / null) — "now" is the only moment `liveAccount` vouches for.
  Fixes entry 66's known limit, whose claimed self-heal covers only ended sessions —
  the mid-session records themselves never heal.
- **A switch renders as "awaiting update", never as mislabeled numbers** (reuses). When no
  reading for the live account has been accepted yet, the bars dim with an
  "account switched — awaiting update" note — the same honest-degradation shape as the
  existing `reset • awaiting update` state — instead of showing the old account's numbers
  under the new account's name.

## Goals

- Auto-pause fires when the active account's window crosses its threshold, regardless of
  which session reports it or when the account was switched.
- The usage bars track the freshest reading of the account actually being billed; an idle
  session's hours-old payload can never drag them backwards.
- The bar's label, its trend samples, and the auto-pilot all agree on which account the
  numbers belong to.

## Non-goals

- Concurrent sessions on *different* accounts via per-session `CLAUDE_CONFIG_DIR`. The
  design reads the default `~/.claude.json`; an exotic multi-config setup falls under
  fail-open and is a documented limitation.
- Rewriting historical usage records mis-attributed under the old scheme. No data
  migration; history stays as recorded.
- Statusline/forwarder changes. The push payload (`rate_limits` + `context_window` +
  `session_id`) is untouched, so no reinstall is needed.
- Per-account rate-limit history across switches (multiple snapshots). One snapshot, one
  live account; the sample buffers already retain per-account history via their tags.

## Design

### The live account (`scripts/account.js` + daemon cache)

Extract `readSubscription()` and `claudeConfigPath()` from `emit.js` into
`scripts/account.js` (emit.js keeps its call sites; no hook behavior change). The daemon
adds `liveAccount()`: `statSync` the file, re-parse only when mtime/size changed, cache the
result — including `null` (missing/oversized/garbage file, no `oauthAccount`). Refreshed on
each `/internal/usage` push and each Stop-time token ingest; **never** called from
`buildStatePayload` (the SSE hot path reads the cached value, per the `/api/storage`
precedent).

`liveAccountSince` is re-stamped to `now` on every observed **change** of the current
`organizationUuid` — per switch, not per id: on an A→B→A flip-back, sessions that worked
under B hold fresh readings of B's numbers, and only a flip-back stamp keeps check 1
rejecting them (a per-id memory would file B's numbers under A). It is *not* the file's
mtime, which advances on unrelated writes (`~/.claude.json` is a general state blob).
Two seams, both deliberate:

- **First-ever observation** (fresh install, upgrade, snapshot loss — no persisted id):
  `since` stays unset and check 1 is unarmed. No switch has been observed, so there is
  nothing to gate; stamping `now` here would drop every idle session's re-push and
  reintroduce the starvation this spec exists to fix, at the upgrade seam.
- **The stamp postdates the readings it judges.** A switch is only observed while handling
  a push, so `since = now` is later than every session's `lastActivityAt` at that instant —
  the switch-revealing push itself is dropped, deliberately: its reading may predate the
  switch, and accepting it risks filing the old account's numbers under the new one. The
  bars show "awaiting update" until the next event bumps a session past `since` — seconds
  for a running session (tool events), one turn for an idle-only fleet. A switch that
  happened while the daemon was down lands the same way: `since` stamps late,
  conservatively dropping gap readings until the next fresh one.

Persisted in `snapshot.json`; on boot, a persisted id matching the file's keeps the
persisted `since`, so a restart mid-account doesn't re-stamp and transiently drop valid
readings.

### The freshness guard (replaces the label guard)

`handleInternalUsage` applies, after the context-gauge half (unchanged — a context reading
is account-independent and is still applied first, unconditionally):

1. **Post-switch check:** `pushFreshness ≥ liveAccountSince`, where `pushFreshness` is the
   pushing session's `lastActivityAt`. A reading made before the switch describes the
   previous account and must not be filed under the new one — this covers both the idle
   session pushing pre-switch numbers *and* the same-session-continues case (its first
   post-switch event bumps `lastActivityAt` past `since`, by which time its payload
   carries the new account's numbers).
2. **Freshest-reading-wins:** `pushFreshness ≥ rateLimitUsage.readingFreshness` (a new
   field stored on accept, persisted with the snapshot). Running sessions always win over
   idle ones; two running sessions interleave freely; an idle session's frozen reading is
   accepted only while nothing fresher exists.

`lastActivityAt` is event-derived (`aggregate.applyEvent` bumps it on every event with a
ts), so it is a proxy, not a receipt: user-side events — `UserPromptSubmit`, a resume's
`SessionStart`, the `idle_prompt` Notification — advance it with no API response behind
them. That cuts both ways, and both edges are accepted: the bump is what rescues a session
past a fresh `since` within seconds; and a session prompted or resumed right after a
switch can re-push its frozen pre-switch payload in the seconds before its first real API
response, passing both checks — a mislabeling window one push wide, self-healed by that
first response. Known limit; do not re-fix with API-only event filtering (complexity for a
seconds-wide gap).

Unknown on either side of either check → that check passes (fail-open). On a fail-open
accept with no `pushFreshness`, `readingFreshness` stores null — and a null stored
freshness makes check 2 pass for every later push. Fail-open ratchets open, never shut.
Both checks live in `usage.acceptUsagePush` (pure); the daemon logs a metadata-only line
per dropped push, deduped like today's `DROP push` diagnostic (entry 86's observability,
re-keyed to the new reasons: `pre-switch` / `staler-than-accepted`).

On accept: `rateLimitUsage = { ...windows, subscription: liveAccount.id, readingFreshness:
pushFreshness, updatedAt: now }`. `updatedAt` **keeps its arrival-time semantics** — the
"updated Xm ago" note and the stale state remain a forwarder-liveness signal, the meaning
the user calibrated in entry 46; re-basing it to reading age would flip every >10-min-idle
session's bars to stale while nothing is wrong. `readingFreshness` is guard-internal, not
surfaced. Sample appends (`appendUsageSample`) tag `sub` with the same value the snapshot
gets — `liveAccount.id`, or the fallback sub when the file is unreadable — so the slices
(`usageSampleSlice` filters to the snapshot's sub) stay coherent. This deliberately
supersedes entry 167's pushing-session tagging: under a single global account the live id
*is* the account a vouched reading belongs to, and the residual leak (a foreign account's
push via multi-`CLAUDE_CONFIG_DIR`, accepted fail-open) is bounded by the ≥10-point
steep-drop rule and accepted under Non-goals. The change-only broadcast rule
(`sameUsageWindows`) is untouched.

### The switch seam in the UI

`usagePayload` already filters both sample slices to the snapshot's subscription. It gains
one comparison: if `liveAccount.id` (cached) is known and differs from
`rateLimitUsage.subscription`, the payload ships the bars in a `switched` state — dimmed,
"account switched — awaiting update" — rather than the old account's fill. The first
accepted post-switch push clears it. With `liveAccount` unreadable the comparison is
skipped entirely (fail-open: today's behavior).

### Auto-pilot

`evalAutoPause` runs for every push that passes the guard — i.e. immediately after the
accept, before the change-only broadcast decision (it must see unchanged re-pushes, as
today, to keep its rising-edge memory current). Its internals — per-window thresholds,
hysteresis deadband, tripped-set (entries 74/88) — are untouched. A switch to a low-usage
account auto-resumes through the existing escape valve (the new account's low reading is
accepted as fresh and reads as a reset/decline). The failure mode this spec exists for —
a correct ≥threshold reading silently discarded before `evalAutoPause` — becomes
impossible: the only discarded readings are provably staler than one already evaluated.

### Live-turn attribution

At Stop-time ingest (daemon.js ~1480–1550), the just-closed turn's usage record takes
`subscription`/`subscriptionName` from `liveAccount` when known, else the session's
captured sub (today's value). Earlier-day groups within the same ingest (resumed-session
backfill) and `/internal/backfill` keep their current attribution — those tokens were
spent at times `liveAccount` can't vouch for. Per-repo `bySubscription`, History's
per-subscription chart, and `subscriptionTotals` all derive from the records, so they
inherit the fix with no further changes.

This is the design's one **irreversible commitment**: post-upgrade closed-turn records
carry live-at-ingest attribution while pre-upgrade and backfill records keep captured/null
— the same `subscription` field, no marker, so the two meanings mix permanently in
`bySubscription` history. Accepted knowingly (Non-goals: no migration); a marker field
would be schema for no consumer.

### Ribbon tile

The Live ribbon's Subscription tile reads `liveAccount` (labelled via the existing
`subLabel`/`subscriptionLabelPattern` path), falling back to `aggregate.
currentSubscription(state)` when `liveAccount` is null — so an API-key or pre-feature
setup renders exactly as today ("—" with the reason in the tooltip). With **zero live
sessions** the tile still reads "—" (entry 115's rendering rule): `liveAccount` refreshes
only on pushes and ingests, so with nothing running it can go stale indefinitely — an
account switched externally would otherwise sit mislabeled on an idle dashboard.

## Alternatives considered

- **Recency-only, no `~/.claude.json` read (Approach B).** Fixes the starvation but keeps
  labels from captured session subs, so after a switch the bar knowingly shows one
  account's numbers under another's name until a new session starts — collides with the
  project's honest-degradation rule. Rejected.
- **Statusline forwards the account id per push (Approach C).** Tags a stale idle-session
  reading (numbers from before the switch) with the *new* account — worse than today —
  so it still needs the freshness guard, while adding a ~200KB read per render. Rejected.
- **Patch `currentSubscription` to most-recently-active (the entry-86 deferred fix).**
  Fixes the idle-session hijack but keeps the false captured-label premise, so the
  mid-session switch bug survives it. Subsumed by this design.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Single agent, Opus 5.** One code path threaded through `scripts/account.js` (new,
  extracted), `emit.js`, `daemon.js` (guard, cache, stamping, ingest attribution,
  payload), `usage.js` (+tests), and `web/app.js` (switched state) — every edit depends
  on the guard's exact semantics, so parallel streams would only trade context. Opus
  because the `(diverges)`/`(breaking)` decisions and the fail-open seams need
  interpreting, not transcribing.
