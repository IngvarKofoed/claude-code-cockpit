# Live usage bars (session 5h + weekly) from the statusline

Show Anthropic's **real** rate-limit usage on the Live page — a session (5h) bar and
a weekly (7d) bar, recreating the `/usage` view inside the cockpit. The numbers come
from the Claude Code **statusline payload** (`rate_limits.five_hour` /
`.seven_day` → `{ used_percentage, resets_at }` — confirmed empirically from a live
payload on the current Claude Code, treated as version-tolerant per `transcript.js`'s
philosophy), which is the only local carrier of this data (hooks don't have it, and
Claude Code persists it nowhere). Because the
statusline is a single, user-owned slot on Claude Code's render hot path, the cockpit
ships an **opt-in statusline forwarder** that renders a colored bar *and* best-effort
POSTs just the rate-limit numbers to the daemon. The daemon keeps one global latest
snapshot and serves it on `/api/state`; the Live ribbon renders the two bars, the 5h
bar carrying a **pace cue** (are you burning faster or slower than the clock?).

## Key decisions

- **Push capture via a shipped statusline forwarder** (new; reuses `emit.js`). A new
  `POST /internal/usage` takes `{ rate_limits }`; the forwarder sends it fire-and-forget
  after printing the bar, so rendering is never delayed. It inherits `emit.js`'s **full
  discipline** — port/token read (`paths.portPath()`/`paths.tokenPath()` +
  `Authorization: Bearer`, `emit.js:132-140`), a ~150 ms POST timeout, and a hard exit
  guard — so a stalled daemon can't leave `node` processes lingering (one is spawned per
  render, even more often than hooks). *Pull* (daemon reads a statusline-written file)
  was rejected — fragile, depends on the user's file/path.
- **One global snapshot, not per-session** (new). Rate limits are account-wide, so
  every session's payload reports the same numbers. The daemon holds a single
  `usage` object; last write wins. No per-repo/per-session bookkeeping.
- **Normalize at ingest, isolate schema drift** (extends the `transcript.js`
  philosophy). The daemon maps the payload's `five_hour`/`used_percentage`/`resets_at`
  to an internal `{ fiveHour: { usedPct, resetsAt }, sevenDay: {…}, updatedAt }`, so a
  Claude Code field rename is a one-line fix and the rest of the code is version-stable.
- **Cross-platform, upgrade-safe invocation** (reuses hooks' `${CLAUDE_PLUGIN_ROOT}`
  idea + `paths.js`). `statusLine.command` invokes the Node renderer **directly**
  (`node "<root>/statusline/statusline-render.js"`) — **no bash wrapper** — so it also
  runs on Windows (the project's cross-platform-parity principle; a `.sh` wrapper would
  strand Windows and never light up the bars). Prefer `${CLAUDE_PLUGIN_ROOT}` for
  `<root>` if `statusLine.command` supports env expansion the way `hooks.json` does
  (verify with `claude-code-guide`) — that survives a plugin upgrade moving the install
  dir; an absolute path is the fallback with a documented "re-run the installer after an
  upgrade" caveat. The renderer `require("../scripts/paths.js")` (resolved against its
  own `__dirname`, cwd-independent) for state dir / port / token — no duplicated path
  logic. Consequence: install *points at* the in-repo file, does not copy it.
- **Pace cue = tick + delta, Settings-selectable** (new; extends config). A new
  `usagePace` config field: `"both"` (default) | `"tick"` | `"delta"` | `"off"`. The
  tick marks the on-pace point on the 5h bar; the delta chip shows the signed gap.
  Validated/merged by `config.js` like every other setting; edited in Settings.
- **Client ticks the pace live** (reuses). The bar's `used_%` only updates on a new
  snapshot, but elapsed-time (hence the tick position + reset countdown) advances every
  second client-side — reusing the same per-second timer that ticks the card elapsed
  clocks. `/api/state` already carries `now` for drift correction.
- **Never a confidently-wrong bar** (reuses the "no wrong zero" rule). No snapshot →
  a subtle "Install the cockpit statusline to see live usage" affordance instead of the
  bars (discoverable, not invisibly absent) — for API-key users or those who haven't
  installed it. A window whose `resetsAt` has passed shows "reset • awaiting update"
  (dimmed), not a fabricated 0 and not the stale high %. A clearly-old snapshot is dimmed
  with "updated Xm ago". Ingested `usedPct` is coerced/clamped to `[0,100]` (mirroring
  `config.js`'s rigor) so a malformed payload can't paint a garbage-width bar.
- **Privacy: forward only `rate_limits`** (reuses the no-content boundary). The
  forwarder strips the payload to the rate-limit numbers before POSTing; the daemon
  stores nothing else (not the cwd/cost/model/session_id the payload also carries).
- **Ship tooling under `statusline/`** (new). `statusline/{statusline-render.js,
  README.md,install.sh}` — a dedicated dir, not mixed into `scripts/` (daemon
  internals). The renderer is cross-platform Node; the **README manual step** (edit
  `settings.json`) is the primary, all-OS install path, and `install.sh` is an optional
  Unix-only convenience.

## Goals

- Show the real session-5h and weekly usage %, with reset countdowns, on the Live page.
- Make the 5h bar answer "am I using too much/too little for how far into the window I
  am?" at a glance.
- Ship the statusline (the colored bar built this session) as installable repo tooling
  with clear docs, and have installing it also feed the dashboard.
- Degrade honestly: no data → no widget; stale/expired → marked, never faked.

## Non-goals

- **Per-model bars** (the `/usage` "Fable 0%" line). The payload carries only
  `five_hour` + `seven_day` aggregate — not available, so not shown.
- **A continuously accurate meter.** It's a snapshot that refreshes only while a
  session renders its statusline; between refreshes only the *time* axis moves.
- **Calculating usage ourselves** from token counts (explored earlier and rejected:
  unknown denominator, account-wide blind spot). This uses Anthropic's real numbers.
- **Auto-registering the statusline.** It stays opt-in — one statusLine slot, and many
  users have their own.
- **A cross-platform *installer*.** The renderer runs everywhere (Node), but `install.sh`
  is a Unix convenience; Windows users use the manual README step (edit `settings.json`).

## Design

### Ingestion (daemon)

`POST /internal/usage` (behind the existing bearer/origin gate, `daemon.js:1879`) reads
the body with `readBody`, extracts `rate_limits`, normalizes to
`{ fiveHour: { usedPct, resetsAt }, sevenDay: { usedPct, resetsAt }, updatedAt: Date.now() }`,
stores it in a module-level `usage` var, and `markDirty()`s to broadcast over SSE.
Each window is normalized **independently**: a window absent from the payload is
`null`; `usedPct` is coerced to a finite number clamped to `[0,100]` (else that window
is `null`); `resetsAt` must be a positive number (else the window keeps `usedPct` but
renders without a tick/countdown — see UI). A structurally malformed body is dropped
(no update), never partially applied.

`buildStatePayload` (`daemon.js:1235`) gains a `usage` field (the stored object, or
`null`). Persistence rides along in `saveSnapshot`/`loadSnapshot` (`daemon.js:1976`/`243`)
as a `usage` key, so a restart keeps the last-known bars until the next statusline tick.

### Live ribbon UI (`web/app.js`, `web/styles.css`)

Below the existing tile row in `renderLiveRibbon` (`app.js:534`), add a usage block:
two labeled horizontal bars — **Session (5h)** and **Week** — each showing `used_%`,
a fill colored by threshold (green < 50 < amber < 80 ≤ red), and a reset countdown
derived from `resetsAt`. Consult the `dataviz` and `frontend-design` skills at build
time (required by `web/CLAUDE.md`) for the exact bar styling.

**Pace cue (5h bar).** The 5h window spans `[resetsAt − FIVE_HOUR_MS, resetsAt]`, so
`elapsedFrac = clamp01((now − (resetsAt − FIVE_HOUR_MS)) / FIVE_HOUR_MS)`. This assumes
a fixed-length window whose budget is spent uniformly (on-pace = elapsed fraction) and
that `resetsAt` marks its end — an assumption tied to Claude Code's rolling-window
semantics, to confirm with `claude-code-guide` (the payload exposes no window length, so
`FIVE_HOUR_MS` is a named constant, not derived). If `resetsAt` is absent, render
`used_%` with no tick and no countdown. Compare `used_%` to `elapsedFrac*100`:

- **tick**: a vertical marker on the bar at `elapsedFrac` (the on-pace point). Fill
  past the tick = over-pace; the overshoot segment reads amber/red. Behind = under
  (calm/green).
- **delta**: a chip showing the signed gap `used_% − elapsedFrac*100`, e.g.
  `▲ +12%` (over) / `▼ −8%` (under).
- `usagePace` selects `both` (default) / `tick` / `delta` / `off`.

The tick and countdown advance every second via the existing client tick loop; `used_%`
refreshes only when a new snapshot arrives.

**Staleness & absence.** `usage == null` → show the install affordance (above), not the
bars. Per window, in **precedence order**: (1) `resetsAt` in the past → "reset •
awaiting update" (dimmed), which **overrides** the age dim since the % is known-stale;
(2) else `now − updatedAt > 10 minutes` → dim the block + "updated Xm ago" (rate limits
don't move without usage, so only clearly-old snapshots are flagged); (3) else render
live. A window with `usedPct` but no `resetsAt` renders the fill without a
tick/countdown.

### Settings

`usagePace` joins the Settings > Dashboard controls (a select). Persisted via
`PUT /api/config` → `config.js` validate/merge/write, hot-reloaded and broadcast like
every other setting. `config.js` gains a validation entry (enum, default `both`).

### Statusline tooling + install (`statusline/`)

- **`statusline-render.js`** — the Node renderer built this session (colored line:
  model · repo · branch · tokens · cost · active · ctx-bar · 5h-bar · reset). Reads the
  payload on stdin (`fs.readFileSync(0)`), prints the line, then fires a best-effort POST
  of `{ rate_limits }` to `/internal/usage` (~150 ms timeout, then exit — `emit.js`'s
  guard), so the printed bar is never delayed. Cross-platform; invoked **directly** by
  `statusLine.command` (no bash wrapper). Locates port/token via
  `require("../scripts/paths.js")`.
- **`README.md`** — what it shows and the **primary, all-OS install**: set `settings.json`
  `statusLine.command` to `node "<root>/statusline/statusline-render.js"` (`<root>` =
  `${CLAUDE_PLUGIN_ROOT}` if supported, else the absolute repo path). Notes that this
  **replaces** any existing `statusLine` (revert by restoring the backup or removing the
  key), and that installing it also lights up the dashboard bars.
- **`install.sh`** (optional, Unix) — convenience that edits the **user-scope**
  `~/.claude/settings.json` (not project/local): writes a **timestamped** backup, and is
  idempotent by *detecting* an already-cockpit `statusLine.command` and skipping — so a
  re-run can't back up an already-modified file over the original. A *different* existing
  `statusLine` is warned about as it's replaced. Windows users use the README step.

## Alternatives considered

- **Pull (daemon reads a statusline-written file).** Works today with the existing
  `~/.claude/last-status.json`, but depends on the user's ad-hoc script/path — unfit to
  ship. Fine only as a throwaway prototype.
- **Compute usage from our own token counts.** Rejected earlier this session: the
  window's token budget isn't a known/linear constant and the account-wide total
  includes usage the cockpit can't see, so any % would be confidently wrong.
- **Plugin-registered statusline (auto-install).** May be possible — verify with
  `claude-code-guide` at build (along with whether `statusLine.command` supports
  `${CLAUDE_PLUGIN_ROOT}`/env expansion, which decides the invocation path above). Even
  if supported, the single-slot conflict with a user's own bar keeps this opt-in, so it
  doesn't change the core design.
