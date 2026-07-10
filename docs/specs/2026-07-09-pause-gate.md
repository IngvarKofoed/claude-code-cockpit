# Pause gate — freeze all tool execution from one control file

A cross-platform way to **instantly freeze every Claude Code session** — main agents
*and* subagents — by flipping one control file, and unfreeze it the same way. A new
**blocking `PreToolUse` hook** (`gate.js`) keeps its process alive polling the control
file while it holds the paused sentinel; when the file flips back it exits and the tool
runs. Because `PreToolUse` is synchronous and fires for subagent tool calls too
(confirmed via `claude-code-guide` against the Claude Code hooks docs), one gate covers
main and subagents across every running session. The control file is the **sole ruler**:
no chat prompt resumes it — only the file (or the dashboard / slash command that writes
it) does. The gate is a **separate** hook from `emit.js` (which stays non-blocking); the
two `PreToolUse` hooks run in parallel, so the gate never delays event logging. The
feature is **opt-in, default off**. Pause/resume are recorded in the event log and the
daemon surfaces a global **paused** state + accumulated **paused time** on the dashboard
and statusline. On top of manual control, an optional **usage auto-pilot** lets the daemon
pause automatically when the 5-hour rate-limit window crosses a threshold (e.g. 95%) and
resume when the window resets — reusing the rate-limit numbers the statusline already feeds
it (entry 42).

## Key decisions

- **Separate blocking `gate.js` `PreToolUse` hook** (new). A second `command` entry in
  `hooks/hooks.json`'s existing `PreToolUse` block, alongside `emit.js`. Claude Code runs
  matching hooks **in parallel** and applies the **most-restrictive** permission decision
  (`deny` > `ask` > `allow`), so the gate can block/deny without delaying `emit.js` and its
  deny cleanly overrides `emit.js`'s no-opinion. `emit.js`'s "always exit fast, never
  block" guarantee (`scripts/CLAUDE.md`) is untouched — the gate is never folded into it.

- **Control file is the enforcement source of truth** (new). `paths.pausePath()` →
  `stateDir()/cockpit.pause` (naming mirrors `cockpit.port`/`cockpit.lock`/`cockpit.token`).
  Content is a bare sentinel from a known set: `paused` (manual) or `paused-usage` (auto) to
  freeze; `running` (or absent/empty) to run. The two paused sentinels differ **only** so the
  daemon can auto-resume its own `paused-usage` without ever lifting a manual `paused` (see
  auto-pause below); the gate treats both identically. The gate reads this **file directly**,
  so pausing works whether or not the daemon is up.

- **Control-file-read-first ordering; config only when paused** (new). The gate reads the
  control file first; **anything not in the paused-sentinel set** (trimmed) → `exit(0)`
  immediately, without loading config. Only when the file is a paused sentinel does it read the
  opt-in flag. So the >99.9% not-paused case is a single tiny file read.

- **Opt-in `pauseGateEnabled` config, default `false`** (extends `config.js`). Added to
  `DEFAULT_CONFIG` + `validateConfig` and edited in Settings. Read **live** on each gate
  spawn (via a defensive light read of `config.json`, *not* `readConfig()` — a hook must
  have no side effects, and `readConfig` can trigger a one-time migration write), so
  enabling/disabling takes effect on already-running sessions. It is the safety master
  switch: a stray `paused` file never freezes a user who hasn't opted in.

- **The second per-tool-call Node spawn is accepted always-on** (diverges from "zero added
  cost"). With a static plugin `hooks.json` the gate hook is always registered, so every
  `PreToolUse` spawns a second short-lived `node` — but in **parallel** with `emit.js`, doing
  one file read in the common case, so marginal wall-clock is ~nil and CPU is one extra
  brief process. Default-off removes *blocking*, not the spawn. The alternative — installing
  the hook into `~/.claude/settings.json` only when enabled (the statusline pattern, entry
  43) — is **rejected**: settings-registered hooks only apply to sessions started *after* the
  edit, so it couldn't pause already-running sessions, violating "across every running
  session."

- **Fail open, fail safe** (new, non-negotiable). Missing / unreadable / empty / any
  non-`paused` control file → tools run. The gate can only hold up to its hook `timeout`;
  the docs confirm a timed-out `command` hook is **killed and the tool proceeds**. There is
  **no documented cap** on `timeout`, so the hook entry sets `"timeout": 86400` (24h,
  best-effort) and the gate's internal `MAX_WAIT` (~86000s) fires *first*: as it nears the
  ceiling the gate prints
  `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"…"}}`
  and `exit(0)` — turning a would-be silent proceed into an explicit deny (verified format).

- **Pause tracked by a *separate* daemon reducer, not the engaged clock** (new; the chosen
  fork). `Paused`/`Resumed` records live in the event log; the daemon folds them via a small
  pure `foldPauseState(events)` into `{ paused, pausedSince, pausedMs }`. `aggregate.applyEvent`
  is **unchanged** — it already ignores session-less events. Active-time accounting is
  therefore unchanged, with one **documented limitation**: a session blocked *mid-tool-call*
  during a pause counts the frozen wait as active time (bounded; a pause-aware engaged clock
  is a noted follow-up).

- **Daemon is the sole pause-*event* writer, via one reconcile function** (new). The dashboard
  toggle hits `POST /api/pause {paused}` → the daemon writes the file, appends the transition
  event, folds, and broadcasts (instant). Slash commands write the file **directly** (daemon-
  independent) + best-effort nudge the daemon; a slow control-file **backstop poll** (+ boot
  reconcile) catches the slash-command path and any direct file edit. One function compares
  the file state to the daemon's last-known and is the only place a `Paused`/`Resumed` line is
  appended, so there are no duplicate events.

- **Usage auto-pilot: auto-pause at a 5h threshold, auto-resume on window reset** (new;
  reuses the entry-42 rate-limit snapshot). A new `autoPauseFiveHourPct` config (0 = off,
  default 0; a user sets e.g. 95). When the daemon's live 5h `usedPct` **crosses up** through
  the threshold it writes `paused-usage`; when a later snapshot shows `usedPct` back below it
  (5h usage is monotonic within a window, so a drop means the window reset) it writes `running`.
  **Edge-triggered**, so a manual resume over-threshold isn't instantly re-paused. It requires
  `pauseGateEnabled` + live usage data (statusline installed) and never clobbers a manual
  `paused` / is never auto-resumed over one. This keeps the "sole ruler" intact — the daemon is
  just another *file writer*, like the dashboard button; a chat prompt still can't resume.

- **`paused` is a derived display status** (new). The client's `effectiveStatus` (`app.js:387`)
  returns `"paused"` when `App.state.paused.active` and the session isn't ended — no per-session
  paused state is stored. Adds `STATUS_LABEL.paused`, a `--st-paused` token + badge/rail CSS, a
  global **PAUSED** banner with a live-ticking paused duration, and a statusline `⏸ PAUSED`
  segment.

## Goals

- Enabled + control file `paused` → every new tool call (main + subagents, all sessions)
  blocks within ~2s and releases within ~2s of resuming.
- Disabled (default) → zero behavior change beyond the parallel early-exiting spawn.
- Missing/garbage control file → tools run. Held past the ceiling → explicit deny.
- With the auto-pilot configured, sessions auto-pause once the 5h window crosses the
  threshold and auto-resume when it resets — without the model being able to talk its way out.
- Dashboard and statusline show the paused state (incl. manual vs. auto) and accumulated
  paused time.
- The pure gate-decision + pause-fold logic is unit-tested (`node --test`).
- Privacy boundary preserved — pause events carry only `{ ts, event, reason? }`, no message
  content.

## Non-goals

- **Per-session paused-time accounting.** Pause is global; only a global `pausedMs` is
  tracked. (Per-session/per-repo paused columns are a possible follow-up.)
- **Excluding paused time from active time** in v1 (the deferred pause-aware clock above).
- **Auto-pause on the weekly window.** The auto-pilot watches the 5h window only; a weekly
  threshold is a straightforward later extension.
- **A pause/resume OS notification.** Out of scope; keep the event set to the existing four.
- **Resuming from chat.** The file is the only ruler; the model saying "resume" does nothing.

## Design

### The gate (`scripts/gate.js` + `scripts/pause.js`)

`pause.js` holds the small, pure, testable core plus the shared file I/O:

- Sentinels: `RUNNING = 'running'`; the paused set `PAUSE_SENTINELS = { 'paused', 'paused-usage' }`
  (`isPaused(s) = PAUSE_SENTINELS.has(s.trim())`).
- `gateDecision(controlContent, enabled) → 'wait' | 'run'` — **pure**: `'wait'` iff
  `enabled === true` and `isPaused(controlContent)`, else `'run'`. Exact-match against the set
  (not a `startsWith`) keeps it truly fail-open — any unrecognized content runs. This is the
  whole fail-open rule in one function.
- `readPauseState()` / `writePauseState(sentinel)` — read/trim and atomic-ish write of
  `pausePath()` (mkdir + write one token: `running` / `paused` / `paused-usage`).
- `pauseGateEnabled()` — defensive light read of `config.json` for the one flag (default
  `false` on any error; no merge, no migration).
- `foldPauseState(events) → { paused, pausedSince, pausedMs }` — **pure**: sums closed
  `Paused→Resumed` spans + the open span, tolerant of unbalanced/out-of-order records.
- `autoPauseDecision({ prevPct, curPct, threshold, sentinel }) → 'pause' | 'resume' | 'none'`
  — **pure**: the auto-pilot's rising-edge / window-reset rule, isolated from the daemon's I/O
  so it can be unit-tested directly (`threshold ≤ 0` → always `'none'`).

`gate.js` is the thin hook shell:

1. `content = readPauseState()`. If `!isPaused(content)` → `exit(0)`. (Read the flag only when
   the file is a paused sentinel.)
2. If paused **and** `pauseGateEnabled()` → enter a `setTimeout` poll (~1.5s). A pending
   timer keeps Node alive (no busy-wait); each tick re-reads the control file and `exit(0)`
   as soon as it's no longer paused.
3. At `MAX_WAIT` (~86000s), print the deny JSON and `exit(0)`.

The loop watches **only the control file** — disabling the feature mid-pause does **not**
release calls already blocked; they wait until the file flips to `running` (the file is the
sole ruler). All work is wrapped in try/catch and every path `exit(0)` (never a non-zero exit
that could disturb a session).

### hooks.json + config

Add a second `PreToolUse` command (string form matching the existing entries) with
`"timeout": 86400`. Add two fields to `config.js` `DEFAULT_CONFIG` — `pauseGateEnabled: false`
(boolean case in `validateConfig`) and `autoPauseFiveHourPct: 0` (number, clamped `[0,100]`;
`0` = off). Both flow automatically through `PUT /api/config` hot-reload, `broadcastConfig`, and
`buildStatePayload().config`. Settings (Dashboard section) gets a `pauseGateEnabled` toggle
(`sw("set-pauseGateEnabled", …)`) and an `autoPauseFiveHourPct` number field, read in
`readSettingsForm`.

### Writers + daemon observation

- **`POST /api/pause {paused: bool}`** (new authenticated route in `handleRequest`,
  behind the existing bearer + Origin gate): `writePauseState(paused)` → reconcile → 200.
  Used by a dashboard **Pause/Resume** button (reuses the `api()` helper, app.js:212, like
  the repo-delete/cleanup POSTs) shown near the Live ribbon; hidden/greyed when the feature
  is disabled.
- **`/cockpit:pause` / `/cockpit:resume`** slash commands: a `node -e` one-liner calling
  `pause.writePauseState(true|false)` (daemon-independent), then a best-effort curl to
  `POST /api/pause` so the daemon reconciles instantly. Named deliberately to **not** overload
  `/cockpit:stop` (which stops the daemon).
- **Reconcile** (daemon, one function): reads the control file, and if its paused state
  differs from the daemon's last-known, appends `{ ts, event: 'Paused'|'Resumed', reason }`
  (`reason` = `'manual'`|`'usage'`, from the sentinel) to today's event log, updates last-known,
  and lets the tail fold + `markDirty()` broadcast. Triggered by `POST /api/pause`, the
  `/internal/event` nudge, a slow (~2s) backstop poll, and boot.

The daemon becomes a **second writer** of the (otherwise hook-written) event log; appends are
single atomic JSON lines at low frequency (only on pause/resume transitions), matching the
existing concurrent-appender assumptions. `handleEvent` gains a `Paused`/`Resumed` branch feeding
the pause tracker (offset-idempotent via the tail, crash-safe, rebuilt on boot replay — the
`replaying` guard still suppresses notify/broadcast side effects). `buildStatePayload` gains a
top-level `paused: { active, since, pausedMs, reason }`, surviving to the client via `applyState`.

**Auto-pilot (the daemon's fourth reconcile trigger).** After each `/internal/usage` update
(`handleInternalUsage`) — and at boot — the daemon evaluates auto-pause when
`cfg.pauseGateEnabled && cfg.autoPauseFiveHourPct > 0` and a live 5h `usedPct` exists: it tracks
the previous `usedPct` and, on the **rising edge** past the threshold, writes `paused-usage` (only
if the file is currently `running`/absent — never over a manual `paused`); when the file is
`paused-usage` and a fresh `usedPct` is back below the threshold (window reset), it writes
`running`. Both go through the same reconcile function, so auto and manual pauses share one
event/accounting/broadcast path and differ only by `reason`. If usage data is absent (no
statusline / API-key session), the auto-pilot simply never fires.

### UI + statusline

`effectiveStatus` returns `"paused"` when `App.state.paused.active`; badge/rail/label/`--st-paused`
follow. A full-width **PAUSED** banner (reusing the `.banner` mechanism, index.html:29) shows a
per-second paused duration (`now − since + pausedMs`, using the existing client tick + `now`
drift correction) and, when `paused.reason === 'usage'`, notes it's automatic (e.g. "auto — 5h
usage ≥ 95%"). The dashboard Pause/Resume button lives near the ribbon (hidden/greyed when the
feature is disabled). `statusline-render.js` reads `pausePath()` + the flag (defensively, like its
existing `paths`/`repo` `require`s) and prepends `⏸ PAUSED` when paused.

### Versioning + tests + docs

Bump `package.json` + `plugin.json` `0.20.0 → 0.21.0` so `ensure.js` replaces the old daemon
with one that knows `/api/pause` + the tracker. Unit tests (`node --test`) target the pure
`pause.js` functions: `gateDecision` (paused+enabled → wait; not-paused / disabled / empty /
garbage → run), `foldPauseState` (balanced, open, unbalanced, out-of-order spans), and
`autoPauseDecision` (rising-edge pause; below-threshold resume only from `paused-usage`; no
re-pause without a fresh crossing; off when `threshold ≤ 0`). Update
`CONCEPT.md` (add `paused` to the status lifecycle + the gate capability), `ARCHITECTURE.md`
(the gate hook, control file, pause events, `/api/pause`, the commands, the config field), and a
`CHANGELOG.md` entry; run `code-review high --fix`. Live verification (main + subagent block/
release ≤2s; disabled = no change; garbage = run; ceiling = deny; UI/statusline show paused +
time) is a build-phase acceptance gate, not unit-testable.

## Resolved decisions

- **Disabling mid-pause does not release** already-blocked calls — the file is the sole ruler;
  the resume path is flipping the file (or the dashboard Resume button). The gate loop watches
  the control file only.
- **Resume writes `running`** (not a delete) — explicit, avoids a delete/create race, and lets
  the daemon/statusline distinguish "explicitly running" from "never set."
- **The daemon includes the slow (~2s) control-file backstop poll** — a cheap single read that
  keeps the *UI* correct for direct file edits and missed nudges (enforcement is already correct
  without it, since the gate reads the file directly).
- **The usage auto-pilot auto-resumes on window reset**, and manual vs. auto pauses are kept
  distinct via the `paused` / `paused-usage` sentinels — a window reset never lifts a hand-set
  pause, and the auto-pilot won't re-pause a manual override until a fresh threshold crossing.

## Alternatives considered

- **Fold the gate into `emit.js`.** Rejected by invariant — it would put a blocking loop on the
  one script that must always exit fast.
- **Install the gate hook into `~/.claude/settings.json` only when enabled** (statusline pattern).
  Rejected: settings-registered hooks apply only to sessions started after the edit, so it can't
  pause already-running sessions.
- **Pause-aware engaged clock** (the accounting fork's Approach A). Deferred: it must settle/freeze
  all sessions on the global pause/resume events and fold each session's `activeDelta` on both the
  live and replay paths — the live-vs-replay seam the codebase guards carefully — for a bounded
  gain. Re-addable without reworking this design.
- **Daemon tracks pause purely in memory/snapshot, no event-log records.** Rejected per the
  requirement to record pause/resume in the event log; the log also gives durable, crash-safe
  history for free.
