# Subscription-aware usage: per-session capture, bar de-pollution, per-subscription stats

Rate-limit numbers (the Live 5h/weekly bars) reach the daemon only via the
statusline forwarder's `POST /internal/usage`, and neither the statusline payload
nor the transcript carries **any** subscription/account identifier — the sole
source is `~/.claude.json` → `oauthAccount` (a *global* file reflecting the
currently-selected subscription). So when you pause near the 5h limit, switch
subscription, and unpause, the old sessions/agents keep running on the OLD
subscription; as they finish they render a statusline that POSTs the OLD
subscription's rate-limit numbers, and the daemon's last-write-wins
(`handleInternalUsage`, `daemon.js:1866`) lets that stale push clobber the NEW
subscription's bar.

The fix rests on one move: **capture the subscription per session, once, at
SessionStart, embedded in the durable event by `emit.js`** — replay-safe, because
the global file has flipped by the time any restart replays old SessionStarts.
From that capture three things follow: (A) the daemon drops a rate-limit push
whose session isn't on the *current* subscription; (B) every usage record and
session carries its subscription as a first-class dimension; (C) the dashboard
gains per-subscription stats and an "active subscription" chip.

## Key decisions

- **Capture subscription in the SessionStart event, not by reading the file
  live** (new). `emit.js` reads `~/.claude.json` `oauthAccount` **once per
  session** (on `SessionStart` only — ~2.6ms for a 205K file, off the per-tool
  path) and embeds a compact `sub` object in the event record. This is the only
  file read the feature adds, and it is in the hook so the value is durable and
  replay-correct — the daemon never reads the file. Absent/unreadable → the field
  is simply omitted (best-effort, hooks never fail).
- **`organizationUuid` is the subscription key; the label is a name, not a tier**
  (new). The key is `organizationUuid` (distinct for personal-Max vs a team org).
  The display label is **name-only** — `organizationName` for a team org (e.g.
  `"FOSS A/S"`), and the account's `displayName` → `emailAddress` → `"Personal"`
  for a personal subscription — deliberately **no tier code** in the label (they
  read as opaque, e.g. `default_raven`). `emit.js` captures the raw `oauthAccount`
  fields the label needs plus the tier codes as `sub` metadata (tooltip / future
  use), but `organizationUuid` alone is the key. Capturing the person's
  name/email is fine here — privacy is a non-concern (local data) and it is used
  *only* to label a personal subscription, never as a key or to correlate
  identity.
- **"Current subscription" is event-derived: the newest *live* session's `sub`**
  (new). No daemon file read, no separate "current" flag — a pure function of
  session state. Chosen over reading `~/.claude.json` in the daemon (Fork 1(a),
  rejected below) because the per-session captures already encode which
  subscription each session is on, so a live file read would be redundant and
  would dent the daemon's event-sourced determinism.
- **Rate-limit push carries `session_id`; daemon drops non-current pushes**
  (extends). `statusline-render.js` adds `session_id` to the `/internal/usage`
  body (privacy is a non-concern per the user — it's local data, and `session_id`
  is already the cockpit's primary key everywhere). `handleInternalUsage` looks up
  that session's captured `sub` and **drops the push** (no bar update) when it
  differs from the current subscription. **Fail-open**: if either the pushing
  session's sub or the current sub is unknown (pre-feature session, API-key
  session, SessionStart missed), the push is accepted as today — the feature never
  makes the bar *worse* than the current last-write-wins.
- **`bySubscription` rollup breakdown, mirroring `byModel`/`byRepo`** (reuses).
  The daily rollup's per-repo record gains `bySubscription[subId] = { label,
  byModel }`, priced server-side exactly like `byRepo` (entry 57). This keeps the
  per-subscription slice O(days-in-range) off any full-log scan, consistent with
  every other breakdown. Attribution is by the *session's captured* sub, so a
  turn is booked to the subscription that session started under.
- **Usage records gain a `subscription` field** (extends). `appendUsage`
  (`daemon.js:1260`) writes the ingesting session's captured sub id onto each
  usage record, so past-day rollups (recomputed on demand from the usage logs)
  reconstruct the per-subscription split without needing session state.
- **Config-driven label extraction, defaulting to the parenthesized part**
  (extends). A new `subscriptionLabelPattern` config (a regex source string)
  extracts the meaningful part of a verbose name. It **defaults to
  `\(([^)]+)\)`** — the contents of the first parenthesized group — so
  `"FOSS Analytical (Lyra)"` renders as `"Lyra"` out of the box. The default is
  safe for everyone because a name *without* parentheses (a plain org name, a
  personal name) simply doesn't match and falls back to the raw name unchanged;
  clearing the field to `""` disables extraction. Applied at **payload-build time
  only** (never at capture or in storage), so a pattern change re-labels every
  surface immediately and touches no stored record — exactly like the pricing
  table is applied at read time. Capture **group 1** when the pattern has one,
  else the whole match; **no match, empty pattern, or a throw → the raw name**
  (never blank). Validated in `config.js` (must compile) and applied inside a
  try/catch, so a bad pattern can never break a label.
- **All-time per-subscription total, mirroring `repoTotals`** (extends). Beyond
  the range-scoped History breakdown, the daemon aggregates an all-time
  per-subscription total (tokens/cost, keyed by subscription id, with label) via
  the same all-time path that builds `repoTotals` (`aggregateReposAcrossDates`),
  exposed on `/api/state` as `subscriptionTotals` and memoized / cache-invalidated
  on the same triggers (so it never runs on the SSE broadcast path). Chosen so a
  subscription summary needs no range and reuses the existing all-time aggregation
  rather than a parallel one.
- **Known limit: a session that switches subscription mid-life is
  mis-attributed** (diverges from perfect accuracy, by explicit agreement). The
  capture is once-at-start, and there is no per-session signal that a running
  session's subscription changed. Per the user's model you switch by starting a
  *new* session, so this doesn't arise; if it ever does, that session's pushes are
  dropped until it ends and its tokens book to its start-sub. It self-heals (the
  new session drives the bar), so it is documented, not guarded.

## Goals

- A rate-limit bar shows only the *current* subscription's numbers; an old
  subscription's lagging statusline pushes after a switch no longer clobber it.
- Every turn's tokens/cost are attributed to the subscription its session ran
  under, enabling per-subscription totals and trends.
- The dashboard shows which subscription is active and breaks token/cost stats
  down per subscription.
- The user can extract a clean label from a verbose subscription name via a
  configurable pattern (e.g. pull the parenthesized part out of
  `"FOSS Analytical (…)"`), without editing stored data.
- Degrade honestly: sessions with no captured subscription (pre-feature, API-key)
  never produce a wrong bar and are bucketed as "unknown" in stats, never a fake
  zero attributed to the wrong subscription.

## Non-goals

- **Using the person as the key, or correlating identity.** `organizationUuid` is
  the key; the account name/email is captured only to *label* a personal
  subscription, never as a key and never cross-referenced across accounts/machines.
- **Handling a mid-life subscription switch of a single session** (see the known
  limit) — out of scope by agreement.
- **Reconstructing subscription for history predating this feature.** Old usage
  records have no `subscription`; they bucket as "unknown" and are not backfilled
  (the transcript has no subscription to recover it from).
- **Per-(repo × subscription) rows in the Repos table.** A repo can span
  subscriptions; per-subscription stats live in History + the Live chip, not as a
  new Repos column (see Open Questions).

## Design

### A — capture + de-pollute the bar

`emit.js` `buildRecord`: on `payload.hook_event_name === 'SessionStart'`, read
`~/.claude.json` (honoring `CLAUDE_CONFIG_DIR`), extract `oauthAccount`, and set
`record.sub` to the raw fields the key + label need — `{ id: organizationUuid,
orgType, orgName, displayName, email, seatTier, userTier, orgTier }` (omitting any
absent). A shared `subBaseName(sub)` helper picks the raw name — `orgName` when `orgType`
is a team/org type, else `displayName || email || 'Personal'`. The final display
label is `subLabel(sub, cfg) = applyPattern(subBaseName(sub),
cfg.subscriptionLabelPattern)` (see *Config* below); the raw base name is what
gets stored, and the pattern is applied only when a payload is built. Wrapped in try/catch; any failure omits `sub` (unknown). This is the
one added read and it is SessionStart-only, so the per-tool hot path is untouched.

`aggregate.js`: `newSession` gains `subscription: null`; `applyEvent`/`updateMeta`
capture `event.sub` when present (guarded like the other metadata — captured on
SessionStart, persists for the session's life). A helper
`currentSubscription(state)` returns the `sub` of the live session with the
greatest `startedAt` that has a known subscription, or `null`.

`statusline-render.js` `postUsage`: include `session_id: data.session_id` in the
POST body alongside `rate_limits`.

`usage.js` `normalizeUsage`: pass through a `sessionId` field (validated string or
null) next to the two windows, so the drop decision stays testable in the pure
module.

`daemon.js` `handleInternalUsage`: after normalizing, resolve
`pushSub = state.sessions[sessionId]?.subscription?.id` and
`curSub = aggregate.currentSubscription(state)?.id`. If both are known and
`pushSub !== curSub`, **return without updating** `rateLimitUsage` (drop). Else
proceed with the existing changed-check/broadcast. Tag the stored snapshot with
the accepted sub (`rateLimitUsage.subscription = pushSub ?? curSub`) so the bar
can be labelled.

### B — subscription as a recorded dimension

`ingestTurn` already has the session id; `appendUsage` (`daemon.js:1260`) adds
`subscription: state.sessions[sid]?.subscription?.id ?? null` to each usage
record. `aggregate.js` `ensureRepo` adds `bySubscription: {}`; the accumulate
functions (`accumulateTurnByModel`/`accumulateTokensByModel`) fold the turn's
`byModel` into `repo.bySubscription[subId] = { name, byModel }` (subId + the *raw*
base name threaded through the `turn` arg, sourced from the session — raw, not the
patterned label, so the label stays a read-time transform). `getRollup`'s past-day
recompute reads `u.subscription` off each usage record — no session state needed.

### C — stats surfaces

- **Live "active subscription" chip.** `/api/state` gains `subscription`
  (`currentSubscription(state)` → `{ id, label }`, or null). `web/app.js` renders
  a muted chip on the Live ribbon showing the active subscription's label; hidden
  when null. The usage bars are implicitly *its* bars now.
- **Per-subscription History.** `buildStatePayload`/`GET /api/history` expose the
  per-repo `bySubscription` aggregated across the range (mirroring how `topRepos`
  and the `by*` breakdowns are surfaced). History gains **one** chart — **Tokens &
  cost per subscription** — in the same flat list as *Cost per day by type* /
  *Subagents by type* (a horizontal-bar or the dual-axis style, matching its
  neighbours). Cost-dependent, so it shows the empty state when cost display is
  off, like the other cost charts.
- **All-time per-subscription total.** `/api/state` gains `subscriptionTotals`
  (subscription id → `{ label, tokens, cost }`), built by the same all-time
  aggregation as `repoTotals` and memoized identically. Feeds a compact
  per-subscription summary and the active-chip's tooltip — a range-free total
  distinct from the History chart's range-scoped breakdown.

Every `label` a payload carries above (the chip's `subscription.label`,
`subscriptionTotals[id].label`, the History chart's per-subscription labels) is
`subLabel(sub, cfg)` — the stored raw `name` with `subscriptionLabelPattern`
applied at build time. Nothing stored holds the patterned label.

### Config — label extraction

New config field `subscriptionLabelPattern` (string, default `\(([^)]+)\)` — the
first parenthesized group's contents, so `"FOSS Analytical (Lyra)"` → `"Lyra"`).
`config.js` `validateConfig` rejects a `PUT` whose value doesn't compile as a
`RegExp` (config left untouched, per the existing validate discipline); `""` means
identity (extraction off). The
`applyPattern(name, pattern)` used above compiles the pattern once, runs
`.exec(name)`, and returns capture **group 1** if present else **group 0**; on no
match, empty pattern, or any throw it returns `name` unchanged — so a label is
never blank and a bad pattern can't break the UI. Settings gains a labelled text
input for it under the Dashboard section (a `PUT /api/config` like every other
setting; the SSE config broadcast re-labels open dashboards live). Applied
read-time, it needs no data migration and re-labels history retroactively.

### Docs to reconcile

- `ARCHITECTURE.md` — *Token usage ingestion* / *Derived rollups*: note the
  `subscription` dimension on usage records + the `bySubscription` rollup map, and
  the SessionStart capture. *Notifications/usage bars* or a new short note: the
  rate-limit bar is per-current-subscription and drops non-current pushes.
- `CONCEPT.md` — a line in per-repository accounting / the usage bars: usage is
  attributed per subscription; the bar reflects the active subscription.
- `ARCHITECTURE.md` *Configuration* — add `subscriptionLabelPattern` to the config
  schema/defaults (a read-time UI-label regex over the subscription name).
- `docs/CHANGELOG.md` — numbered entry at build time.

## Alternatives considered

- **Fork 1(a): daemon reads `~/.claude.json` for "current."** Authoritative
  "what's selected now," but redundant once each session's sub is captured in its
  events, and it adds a live external-file dependency to an otherwise
  event-sourced daemon. Rejected in favour of the event-derived newest-live-session
  rule.
- **`resets_at` fingerprinting (poison the old window on a detected switch).**
  Fixes the bar with no `emit.js`/forwarder change, but gives no per-session
  attribution — so B/C would force per-session capture anyway, at which point the
  session-id drop is strictly cleaner and needs no heuristic.
- **Fork 2(b): on-demand scan for per-subscription stats.** Store `subscription`
  only on usage records and aggregate by scanning logs per query. Smaller rollup
  surface but a full-log scan on the stats path and a divergence from the
  established `by*` breakdown pattern. Rejected.
- **Daemon reads the file at SessionStart-ingest instead of `emit.js`.** Avoids a
  hook change, but not replay-safe: a restart replaying old SessionStarts would
  read the now-switched file and mis-tag old sessions. The durable-event capture
  is the only replay-correct spot.
