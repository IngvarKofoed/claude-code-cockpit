# Pause gate — per-session "safe to close" indicator

When you click Pause, the gate only intercepts each session's **next** tool call; a tool
already executing (a long `Bash`, a build) runs to completion first, and a background
workflow's subagents each park one at a time. The current UI hides all of this: it stamps
every running/idle card with **"Paused"** the instant you click (`web/app.js` `displayStatus`,
which the comment at `app.js:569` confirms is a display-only overlay with *no per-session
paused state*). So the badge means *the gate is armed*, never *this session has come to rest* —
which is exactly the question you need answered before closing the laptop.

This feature makes the gate report, per session, when it has **actually parked** a tool call,
so the dashboard can distinguish *still finishing a tool* from *parked — safe*, roll that up
into a top-level **"safe to close"** state, and fire one OS notification when the last session
comes to rest (the walk-away signal — you shouldn't have to watch the dashboard). It is
observability only; the gate's enforcement is unchanged.

## Key decisions

- **`gate.js` emits one `Gated` marker on park** (extends / new event). When the gate confirms
  paused-and-enabled and enters its poll loop (`gate.js:94`), it best-effort appends a
  `{ ts, event: 'Gated', session_id, owner_pid, tool_name }` record to today's event log and
  nudges the daemon — reusing `emit.js`'s append+ping pattern. This is a positive, logged
  "this session's tool is now blocked pre-execution" signal.
- **Release is a replay-safe clear on the `Resumed` *record*, not a per-session `Ungated`**
  (diverges from the approach preview). Resume is *always global* — any resume writes the control
  file, which the daemon's pause-transition logger (`daemon.js:947`) appends as one `Resumed`
  event. Clearing `gatedSince` for every session must fire **when that `Resumed` record is seen
  in the event stream, including during boot replay** — *not* only on a live `reconcile()`
  transition. This is load-bearing: the durable log holds `Gated` but no `Ungated`, so a cold
  boot re-derives *set* from the log; if the clear rode only on the live transition, a session
  that parked-and-resumed earlier today would replay its `Gated`, never see a transition (the
  file already reads `running`), and carry a **stale `gatedSince`** — a false "safe to close" on
  the next pause. Handling the session-less `Resumed` record in the stream keeps the log
  self-describing (per ARCHITECTURE's boot invariant). Dropping a separate `Ungated` still avoids
  the ordering race with the triggering `PreToolUse` and a concurrent-subagent miscount.
- **`gate.js` now parses `session_id` from stdin** (diverges). It was deliberately
  payload-agnostic; it now does a minimal, wrapped `JSON.parse` for `session_id` only. On any
  parse failure it skips the marker and still blocks — the gate decision never depends on it.
- **The marker write never affects the gate** (reuses failure-isolation rule). Append + ping are
  wrapped in their own try/catch; a write error is logged to stderr and swallowed. Every
  `gate.js` exit path stays `exit 0`, and the poll/deny timing is untouched.
- **Per-session `gatedSince` anchor** (reuses `waitingSince` pattern). `aggregate.applyEvent`
  gains a `Gated` case that sets `session.gatedSince = event.ts` (set-once). It is an ISO
  string mirroring `waitingSince`, cleared on the global `Resumed` clear and on `SessionEnd`.
- **"At rest" is computed once, server-side, and exposed as a per-session `atRest` boolean**
  (new). A session is at rest iff `gatedSince != null` **or** it is not working —
  `!(status === 'running' || aggregate.isEngaged(session))`. Not at rest iff
  `(running or engaged) and gatedSince == null` — the "still finishing a pre-pause tool" state.
  No timestamp math: the `Gated` marker's presence *is* the parked signal. The client renders the
  badge from `atRest`; it must **not** re-derive it from `effectiveStatus` (which collapses
  `bgTasks` into `waiting`/`error` and would disagree with the server for a background workflow
  blocked on a permission prompt).
- **Daemon computes `paused.allAtRest` server-side** (extends the `paused` payload block). Exposes
  `paused.allAtRest`, `atRestCount`, and the session total for the "N of M" progress line
  (`activeCount` is derivable, not stored). The value is *read* into the payload but *computed and
  edge-checked* in the write paths (below), never inside `buildStatePayload`.
- **One OS notification per pause, on the first all-at-rest edge** (extends notify path, new config
  event). Built through `notify.buildNotification` (so the `osNotifications` master + per-event
  gating stay in one place) as a session-less global event, and **latched**: fired at most once
  per pause span (reset on `Resumed`), so ordinary churn that flips `allAtRest` back and forth
  mid-pause can't re-ping. Suppressed when there are no live sessions (`M === 0` is not a
  meaningful "safe to close"). Gated on the new `events.safeToClose` toggle (default `true`).
- **Honest badge replaces the instant-"Paused" overlay** (diverges — this is the bug fix).
  `displayStatus` shows "Paused — parked" only for an at-rest session; a session still finishing
  a tool keeps its working badge/timer (e.g. "Pausing… finishing `Bash`"), not "Paused".

## Goals

- Tell me, per session, whether it has actually come to rest under a pause, or is still
  finishing a tool that passed the gate before I clicked.
- Roll that into one top-level "safe to close" state on the PAUSED banner.
- Fire a single OS notification the moment the last session parks, so I can walk away.
- Change nothing about how the gate enforces the pause.

## Non-goals

- **Per-session pause *control*.** Pause stays global (one control file); this is observability.
- **Fixing "active time counts during a pause"** (CHANGELOG #63 known limit) — a separate clock
  concern, untouched here. A parked session still reads `running`/engaged and still accrues
  active time.
- **Seeing a `run_in_background` `Bash`** launched before the pause. It emits `PreToolUse` then
  an immediate `PostToolUse` (the spawn returns) and no further hook, so neither the gate nor the
  daemon can confirm the shell itself has finished — the same blind spot as active-time. Flagged,
  not solved.
- **Perfectly classifying a paused *background workflow*.** Once a `bgTasks > 0` session's tool is
  parked (`gatedSince` set) it counts as at rest — accepted so a frozen workflow can still reach
  "safe" (it can never progress to fully idle while paused). The residual cost: if a *concurrent*
  subagent tool passed the gate just before the pause and is still finishing, the session can read
  "safe" a moment early. A rare, documented false-safe, of a piece with the `run_in_background`
  blind spot above; the common single-foreground-tool case is exact.

## Design

### The park signal (`gate.js`)

`gate.js:main` already reaches a point (after `gateDecision(...) === 'wait'`, entering the `tick`
poll at `gate.js:94`) where it *knows* it is about to freeze this tool call. There it emits the
`Gated` marker once, then polls as today. The record carries only metadata (`session_id`,
`owner_pid` from `process.ppid`, `tool_name` if present) — never `tool_input`, honoring the
privacy boundary. The append targets `paths.eventLogPath(paths.dateStr())` and the ping hits
`/internal/event`, both copied from `emit.js` and fully wrapped so a failure is invisible to the
gate. No repo walk (kept off the blocking hook; the daemon already knows the session's repo).

Because both `emit.js` (the triggering `PreToolUse`) and `gate.js` (the `Gated`) fire on the same
`PreToolUse` in parallel, the two records land in the log in either order. This is safe:
`PreToolUse` sets `currentActivity`/`status=running` and never touches `gatedSince`; `Gated` sets
`gatedSince` and never touches status. After both, the session is `running` with `gatedSince` set,
and the at-rest rule reads it as parked.

### Folding it in (`aggregate.js` + daemon)

`aggregate.applyEvent` gains:
- `case 'Gated'`: `if (session.gatedSince == null) session.gatedSince = event.ts;`
- `SessionEnd`: also `session.gatedSince = null` (session gone).

The **global** clear must be replay-safe. `Paused`/`Resumed` are session-less, so `applyEvent`
drops them — but the daemon's event ingestion (`handleEvent`, and its boot-replay path) sees every
record. When a `Resumed` record passes through the stream (**live or during replay**), the daemon
loops `state.sessions` and nulls `gatedSince` on each. Doing it here, not only on a live
`reconcile()` transition, is what keeps a cold boot correct: replaying today's log re-sets
`gatedSince` from each `Gated`, and the matching `Resumed` record clears it, so a
parked-then-resumed session doesn't survive the boot as falsely parked (see the Key-decisions note
on why the log's `Gated`-without-`Ungated` asymmetry forces this). `gatedSince` is also added to
the snapshot's persisted per-session fields so the fast-start path doesn't briefly lose it.

### At-rest classification + payload

At-rest is computed **once**, server-side, in a small helper over non-`ended` sessions: at rest iff
`gatedSince != null || !(status === 'running' || aggregate.isEngaged(session))`. The daemon:
- exposes a per-session `atRest` boolean and the raw `gatedSince` anchor on each card,
- extends the `paused` block (`daemon.js:~1503`) with `allAtRest` (`paused.active && every session
  atRest`), `atRestCount`, and the session total (the client derives `M − atRestCount`).

`buildStatePayload` only *reads* these; the `allAtRest` edge check that fires the notification runs
in the write paths (see OS notification), never in the payload builder — `buildStatePayload` is
also called by `GET /api/state`, so a stray dashboard poll must not be able to fire a notification.

### Dashboard

- **Badge / timer** (`displayStatus`, `STATUS_LABEL`, the card timer): under an active pause, an
  `atRest` session shows "Paused — parked" and freezes its timer; a not-`atRest` session keeps its
  running badge/colour and ticking timer with a "finishing…" hint. The badge reads the server's
  `atRest`, not a client re-derivation. This corrects the misleading instant-"Paused".
- **Banner** (`renderPauseBanner` / `tickPauseBanner`): while parking, "⏸ Paused · N of M
  sessions at rest"; once `allAtRest`, "✓ All sessions at rest — safe to close" (green); with no
  live sessions, the existing plain paused banner (no "N of M"). The paused-duration timer is
  retained.

### OS notification

The all-at-rest edge check runs at the **end of `handleEvent`** and the **end of `reconcile()`**
(the two write paths that mutate session/pause state) — never in `buildStatePayload`. It fires the
"safe to close" notification on the first transition to `allAtRest` within a pause span, through
`notify.buildNotification`/`notify.notify` as a session-less global event so the `osNotifications`
master and `events.safeToClose` gating live in `notify.js`, not inline. A per-pause **latch**
(set on fire, reset on the `Resumed` clear) makes it at-most-once per pause even as `allAtRest`
flaps; `M === 0` never fires. The latch is initialized so a daemon that boots straight into an
already-safe pause doesn't spuriously notify.

### Config

`events.safeToClose` must be added to `DEFAULT_CONFIG.events` (`config.js:31`) with default
`true` — `validateConfig` iterates the default keys and **drops** any it doesn't know, so an
unlisted event key would be silently discarded on `PUT`. It gets a Settings toggle alongside the
existing four events (the project rule: all config is edited in the dashboard). It stays gated by
the `osNotifications` master, so the default-on notification is still off for anyone with OS
notifications disabled.

## Alternatives considered

- **Daemon infers parked-ness from `paused.since` vs the current tool's start time, no `gate.js`
  change** (the rejected "Approach B"). Elegant and leaves the critical hook untouched, but
  inferential and produces no logged parked record; the explicit marker was preferred for
  auditability and a positive signal.
- **Separate per-session `Ungated` event** (the original Approach-A sketch). Dropped in favor of
  the replay-safe `Resumed` clear — see Key decisions. Residual edge: the deny-at-ceiling path
  (~24h pause, no `Resumed`) leaves a stale `gatedSince` until the session's next `Gated`/`Resumed`
  or `SessionEnd`; benign (it only reads as parked, and only while still paused) and acceptable for
  a pathological 24h hold.
