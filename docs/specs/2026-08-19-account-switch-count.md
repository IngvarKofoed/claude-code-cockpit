# Daily account-switch count

The daemon already *detects* every subscription switch — `refreshLiveAccount()` stamps
`liveAccountSince` on an observed known→known change of the `organizationUuid` and writes one
diagnostic line to `daemon.log` — but nothing durable records it, so "how many times today did
I switch account?" is answerable only by grepping an operational log that rotates and only
covers the current daemon's lifetime. This spec records each switch as an `AccountSwitched`
event in the durable per-day event log, folds it into a top-level per-day rollup counter, and
surfaces today's count on the Live ribbon's Subscription tile as a muted suffix — `Corvus + 5`.

## Key decisions

- **The switch becomes an event in the hook-written event log** (reuses). The daemon is
  already a sanctioned low-frequency second writer of that log: `reconcile()`
  (`daemon.js:1225`) appends session-less `Paused` / `Resumed` lines on transitions only.
  `AccountSwitched` is the same shape — one atomic append, on a transition, from the daemon.
- **The count is a top-level rollup field, not per-repo** (extends). `createRollup`
  (`aggregate.js:538`) already carries a non-repo-scoped `hourActive[24]` beside `repos`;
  `accountSwitches` joins it. An account switch has no repository, so filing it under one
  would be a lie — and the ribbon needs one global number, not a sum over repos.
- **Derived from the log on both paths, exactly like `byTool`** (reuses). The rescan branch
  lives in `aggregate.accumulateActiveFromEvents` (`aggregate.js:725`) and the live branch in
  `handleEvent`, below its `if (replaying) return;` guard — so the boot rebuild counts the
  day's history once and the live tail extends it, with no double count. This is what makes
  the counter crash-safe and replayable without any new persistence.
- **Every retained past day gets a real count, from day one** (extends). `getRollup`
  (`daemon.js:1958`) never trusts a frozen rollup file for a past day — it re-derives from
  that day's usage log plus its event log — so the per-day series exists as soon as the events
  do, and a History chart can be added later against real history rather than starting empty.
- **The event stores ids plus RAW base names, never rendered labels** (reuses). Usage records
  already persist `subscriptionName` raw so a recomputed past day keeps a real label (changelog
  68); `subscriptionLabelPattern` is applied at read time only. Note what a base name can be:
  `aggregate.subBaseName` falls back to `displayName || email`, so on a personal account the
  name written here **is the account email** — no new exposure (every `SessionStart` event
  already stores the whole `sub` object including `email`, and every usage record its
  `subscriptionName`), but not a field that can be described as email-free.
- **A one-shot marker event separates "0 switches" from "not recording yet"** (new). The first
  boot that lacks one appends `AccountSwitchTrackingStarted` to the day's event log; the
  earliest such marker across retained days is when recording began, so every earlier day is
  honestly *unknown* rather than a confident 0. Recorded now because it is cheap now and
  unreconstructable later — the project's no-wrong-zero rule applied to a series that does not
  have a reader yet.
- **The tile's count is a sibling payload field, not nested under `subscription`** (new).
  `buildStatePayload`'s `subscription` is `null` whenever the account is unknown or no session
  is live (changelog 190), but the day's switch count is still a true fact then. A separate
  `accountSwitchesToday` keeps the two independent.
- **No new store, no new endpoint, no config key** (reuses). Everything rides the event log,
  the rollup, `/api/state`, and the existing SSE frame.

## Goals

- Record every observed account switch durably, attributed to the local day it was observed.
- Show today's count on the Live ribbon's Subscription tile: `Corvus + 5`.
- Leave the per-day series *derivable* from the store, so a History chart is a later small
  addition rather than a feature that has to start collecting from scratch — and distinguishable
  from the days the cockpit was not recording switches at all.

## Non-goals

- A History chart, or any `/api/history` payload change. The field would be dead payload with
  no consumer, and a pre-feature day would read a wrong 0 in it; the rollup already holds the
  number, so adding it alongside a chart later costs one line and loses no history meanwhile.
- Reconstructing switches from before this ships — no back-history exists and none is invented.
- Counting switches the daemon never observed (see the floor limit in Design).
- Per-session or per-repo attribution of a switch.
- Making the count drive anything: no notification, no auto-pause input, no sort key.

## Design

### The event

`refreshLiveAccount()` (`daemon.js:266`) already owns the detection branch — `liveAccountId`
known, a different known `id` observed. Beside the existing `liveAccountSince` stamp,
`markDirty()` and `log()`, it appends one line to today's event log:

```json
{ "ts": "2026-08-19T13:56:48.509Z", "event": "AccountSwitched",
  "from": "4099b385-…", "to": "3fff592c-…",
  "fromName": "FOSS Analytical (Lyra)", "toName": "FOSS Analytical (Phoenix)" }
```

`toName` is `aggregate.subBaseName(liveAccountValue)`; `fromName` needs the previous account's
name, which the daemon does not currently keep — so `liveAccountId` gains a companion
`liveAccountName`, assigned in the same place (`refreshLiveAccount`'s `id != null` block) and
**persisted alongside it**: the snapshot's `liveAccount: { id, since }` becomes
`{ id, since, name }`. Restoring it is what keeps the *first* switch after a restart
self-describing; a pre-upgrade snapshot has no `name`, so that one switch carries
`fromName: null`, which readers must tolerate.

The append mirrors `reconcile()`'s exactly, including its target — `mkdirSync(eventsDir)` then
one `appendFileSync` of `JSON.stringify(rec) + '\n'` to `eventLogPath(currentDate)`, the
daemon's own notion of the open day, so the line lands in the file whose offset the tail is
tracking. Wrapped in try/catch that logs and continues. Unlike the pause
append, a failure here must **not** abort the surrounding work — the stamp, the drop guard and
the broadcast are the load-bearing parts of that branch, and a lost count is the cheaper loss.
An append failure therefore loses exactly one switch from the count and nothing else.

The daemon writes it and the tail reads it back; there is no direct fold. `reconcile()` folds
directly because a transient tail error could strand its baseline mid-transition, and a paused
span with a wrong start is a visible lie. A counter has no baseline and no span: the offset is
not advanced by a failed read, so the line is simply counted on the next successful tail
(`TAIL_MS`, 500ms — not the ~2s pause poll, which runs `reconcile()` and never tails).
Keeping one path also keeps the boot rescan and the live tail
arithmetically identical, which is the property the `byTool` comment exists to protect.

### Marking when recording began

On boot the daemon appends one `{ ts, event: 'AccountSwitchTrackingStarted' }` line to today's
event log (same append shape as above), unless the snapshot's `switchTrackingMarkedDate` names a
day whose event log **still exists**. Recording the marker's *date* rather than a boolean is
load-bearing: a bare flag would keep suppressing after `/api/data/cleanup` unlinked the marker's
day, leaving no marker anywhere and destroying the very distinction this exists to draw.

The snapshot is only a write-suppressor; the *truth* stays in the log, read as **the earliest
marker across retained day files**. That split is deliberate — a snapshot loss re-appends a
marker on a later day, and earliest-wins simply ignores it, so no snapshot state is ever
load-bearing for the answer. Two honest degradations follow: if `/api/data/cleanup` removes the
day holding the earliest marker, the unknown region grows back to the re-marked day; and the
marker's own day is *partial*, since recording began part-way through it.

Nothing reads the marker yet — no fold, no payload field, no rollup counter. It exists so the
per-day series has a floor when something eventually does.

### Folding it

- `aggregate.createRollup` → `{ date, repos, hourActive, accountSwitches: 0 }`.
- `aggregate.accumulateActiveFromEvents` gains an unconditional branch alongside the existing
  `PreToolUse` / `SubagentStart` ones: `if (ev.event === 'AccountSwitched') rollup.accountSwitches = num(rollup.accountSwitches) + 1;`.
  Session-less, so it takes no `sess` or `repoRoot` guard — the reason it cannot live in the
  active-delta fold.
- `handleEvent` gains the mirror branch below the replay guard, next to the `byTool` /
  `subagents` tallies. It touches no repo entry, so it invalidates no cache: `repoTotalsCache`
  and `subscriptionTotalsAllTime` are per-repo/per-subscription token aggregates and are
  unaffected. It needs no `markDirty()` of its own — `handleEvent` already broadcasts at its
  end. Consequence: the label flips at the switch instant (`refreshLiveAccount` marks dirty
  there) while the count lands up to one tail later, so the tile can read `Phoenix + 4` for
  ~500ms after the switch to Phoenix. Accepted — folding optimistically to close it would
  double-count against the tail.
- `rolloverDay` needs no change: it builds a fresh rollup, so the count resets at local
  midnight by construction. Nothing ever reads a persisted rollup *file* back — `getRollup`
  re-derives a past day from its logs — so no on-disk rollup needs migrating; the `num()`
  guards are belt-and-braces against a mid-upgrade in-memory rollup.

`applyEvent` needs no change — it ignores session-less events already, which is what makes the
`Paused`/`Resumed` lines harmless to session state today. Every other event-log consumer is
likewise inert to the new type: `addActiveFromEvents` gates on `session_id && repo_root`,
`accumulateSessionStatsFromEvents` on `session_id`, and `/api/repos/delete`'s rewrite filter
keeps any line whose `repo_root` isn't the deleted repo — which a session-less line never is.

Three ARCHITECTURE.md sections enumerate exactly what this adds and so must be updated with it:
*Hook wiring* / *Event model & storage* (the new event type and its daemon writer), *Derived
time-series & rollups* (the `accountSwitches` field), and *Dashboard* (the tile suffix).

### Payload and tile

`buildStatePayload` (`daemon.js:1905`) adds one field beside `subscription`:

```js
accountSwitchesToday: num(todayRollup.accountSwitches),
```

`subscriptionTileHTML` (`web/app.js:1393`) appends a muted suffix to the tile's value, in both
its known-label and its `—` branch:

```html
<div class="tile__value">
  <span class="tile__value-name">Corvus</span><span class="tile__value-sub">+ 5</span>
</div>
```

The name needs its **own** span, and that is load-bearing rather than tidiness:
`.tile--sub .tile__value` already sets `white-space: nowrap; overflow: hidden;
text-overflow: ellipsis` on the *container* (`styles.css:355`), which clips the end of the line
box — so a bare-text name plus a suffix span would ellipsize away the **count** first, the
opposite of what is wanted. The container therefore becomes `display: flex` with the
ellipsizing rules moved onto `.tile__value-name` (which shrinks), while
`.tile__value-sub` is `flex: none`, `--ink-2` and a lighter weight (which doesn't) — so a long
account name truncates and the count survives, since the count is the part that changes and
the name is the part you already know. The tooltip gains one clause: `· 5 account switches
today` (singular at 1), plus the floor caveat below.

The suffix costs width in an already-tight ribbon (changelog 142: `minmax(150px, 1fr)` tiles
that wrap to a second row below ~1315px viewport). Accepted, and bounded by the absent-at-zero
rule below — a `+ N` at N < 10 adds ~4 characters to a tile sized for a name.

Two rules on when the suffix renders:

- **At zero it is absent** — the tile reads plain `Corvus` until the day's first switch. A
  permanent `+ 0` spends tile width to say nothing, and its absence is unambiguous.
- **It renders even when the label does not** — `— + 5` when no session is live or the account
  file is unreadable. The count is a today's-total like every other ribbon tile, and stays
  true regardless of whether the *identity* half is knowable at this moment.

### Limits, all stated rather than fixed

The count is a **floor on observed switches**, not a count of switches:

- Detection only happens when `refreshLiveAccount()` runs — on a statusline usage push or a
  Stop-time ingest. An A→B→A flip-back between two refreshes is invisible.
- A switch made while the daemon was down is observed at the first refresh after boot and
  timestamped then, so one that happened before midnight lands on the wrong day. This is
  changelog 187's late stamp, inherited rather than introduced.
- A first-ever observation does not stamp a switch (changelog 186), so a fresh daemon or a
  cleared snapshot never invents one at boot.
- A day whose event log was removed by `/api/data/cleanup` loses its count — the same
  retention limit active time already has.
- An account whose `oauthAccount` carries no `organizationUuid` never trips the detector:
  `refreshLiveAccount`'s whole transition block sits under `if (id != null)`. Such a setup shows
  no suffix ever, indistinguishable from a day with no switches.
- Days before this ships have no events, so their count is **unknown** rather than 0 — that is
  exactly what the tracking marker above establishes. Today's tile is unaffected either way; the
  distinction exists for whatever reads the per-day series later.

## Alternatives considered

- **A snapshot-only counter** — `{date, n}` bumped in `refreshLiveAccount`, persisted by the
  existing 5s snapshot, reset in `rolloverDay`. ~20 lines, no event type. Rejected: today's
  number dies at midnight, so the per-day question it was asked to answer stays unanswerable,
  and adding the event later would start with no back-history.
- **Deriving switches from the usage log's `subscription` field** — zero writes, since each
  closed turn already carries the account it was attributed to. Rejected on measured data:
  post-v0.50.0 days are exact (2026-08-19 derives 5, matching `daemon.log`), but earlier days
  read 45–56 phantom switches, because those records carry each session's *captured* account
  and concurrent sessions on different accounts interleave (changelog 188/189). It also cannot
  see a switch with no turn closed under the new account, and lags each switch by a turn.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Single agent, Opus 5.** One dependency chain, four files: the `aggregate.js` rollup field
  has to exist before the daemon's two folds, and `accountSwitchesToday` before the tile reads
  it. Splitting it would only manufacture conflicts in `daemon.js`, which carries five of the
  edits.
- Opus rather than a cheaper tier because the load-bearing edits interpret decisions rather
  than transcribe them: the fold must sit below `handleEvent`'s replay guard, the marker's
  snapshot flag must stay non-authoritative, and the tile's flex/ellipsis fix inverts what the
  existing CSS does. The `ARCHITECTURE.md` and `CHANGELOG.md` updates are the only mechanical
  part and are too small to hand off separately.
