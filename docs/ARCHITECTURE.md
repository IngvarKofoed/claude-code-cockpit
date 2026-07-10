# claude-code-cockpit — Architecture

## Summary

A Node.js Claude Code plugin. Tiny, short-lived **hook scripts** (`emit.js`) observe session events, append them to a durable local **event log**, and best-effort ping a long-running local **daemon**. The daemon (`daemon.js`) replays and tails the log, maintains live per-session state and per-repository rollups, enriches them with token usage parsed from session transcripts, serves a buildless single-page **dashboard** over `127.0.0.1` with Server-Sent Events for live updates, and dispatches OS notifications and sounds via `node-notifier`. The daemon is started and auto-revived by a `SessionStart` hook and kept as a singleton via a port/pid file.

This design deliberately reuses the mechanisms proven in [`claude-code-notifier`](https://github.com/IngvarKofoed/claude-code-notifier): stdin-JSON hook scripts, `node-notifier`, XDG/APPDATA path resolution, JSONL logging, and detached-worker dispatch. (Configuration, however, is edited in the dashboard — there is no TTY wizard.)

## Technology choice (and why)

**Chosen: Node.js runtime + a localhost web dashboard, backed by an always-on daemon.**

| Option | Verdict | Reason |
| --- | --- | --- |
| **Node + web dashboard** ✅ | **Chosen** | Reuses the notifier's entire stack (Node, `node-notifier`, paths, logging, workers). Web UI is trivially cross-platform with the richest visuals, no native build, no code-signing, minimal install friction. |
| Python + web dashboard | Rejected | Adds a Python prerequisite alongside the existing Node stack; cross-platform desktop-notification and sound stories are weaker than `node-notifier`. |
| Electron / Tauri desktop app | Rejected | Per-platform packaging and code-signing, large footprint (Electron) or a Rust + platform-webview build (Tauri); awkward to ship through a git-based plugin marketplace. |
| Terminal UI (ink/blessed) | Rejected | Limited visuals for a dashboard and competes with the Claude Code terminal for screen space. |

**Always-on daemon vs. on-demand:** the live "running for 3m 12s" view requires a process that holds state between hook firings and pushes updates. An on-demand model can only render history. We therefore run a small daemon, spawned and revived by `SessionStart`, singleton-guarded, and optionally idle-shutdown.

## Component diagram

```
┌──────────────────── Claude Code session(s) ─────────────────────┐
│  hooks fire on:  SessionStart · UserPromptSubmit · PreToolUse ·  │
│  PostToolUse · Notification · Stop · StopFailure · SubagentStart │
│  · SubagentStop · SessionEnd                                     │
└───────────────┬──────────────────────────────────────────────────┘
                │ stdin JSON  (one short-lived process per event)
                ▼
        scripts/emit.js  ── append event ──▶  Event log (JSONL, per day)
        (parse → exit 0) ── best-effort ───┐        in stateDir/events/
                            POST /internal  │              │
                                            ▼              │ replay + tail
                              ┌──────────── daemon.js ─────┴───────────┐
                              │  aggregate  events → live state +       │
                              │             per-repo rollups            │
                              │  transcript tail JSONL → token usage    │
                              │  pricing    model → estimated $         │
                              │  notify     node-notifier + sounds      │
                              │  http       127.0.0.1:PORT              │
                              │   ├─ GET  /              dashboard      │
                              │   ├─ GET  /api/state     snapshot JSON  │
                              │   ├─ GET  /api/stream    SSE deltas     │
                              │   ├─ GET  /api/history?range=…          │
                              │   ├─ GET  /api/sessions  list sessions  │
                              │   ├─ GET  /api/config    read config    │
                              │   ├─ PUT  /api/config    update config  │
                              │   ├─ GET  /api/storage   store size     │
                              │   ├─ POST /api/data/cleanup  prune old  │
                              │   ├─ POST /api/repos/delete  del a repo │
                              │   ├─ POST /internal/event  (hook ping)  │
                              │   └─ GET  /health        (singleton)    │
                              └──────────────┬──────────────────────────┘
                                             │ SSE + JSON
                                             ▼
                                  Browser dashboard (web/)
                            live cards · per-repo table · charts
```

## Runtime & dependencies

- **Runtime:** Node.js (user-provided; documented prerequisite, same as the notifier).
- **`node-notifier`** — cross-platform OS notifications with bundled platform binaries. Reused.
- **HTTP server:** Node's built-in `http` module — no web framework, to keep the dependency surface tiny. It also serves the config read/write API, so **all settings are edited in the dashboard** — there is no separate TTY wizard, and thus no `prompts` dependency.
- **Storage:** append-only **timestamped JSONL** (a hook-written event log + a daemon-written token-usage log) plus materialized daily-rollup JSON — no database. Every record carries an ISO `ts`, so the store *is* the time-series behind the graphs. This preserves the notifier's zero-native-dependency, zero-build property; `node:sqlite` (built-in) or `better-sqlite3` is a documented scale-up path *only if* history queries outgrow JSONL.
- **Dashboard:** a **buildless SPA** — plain HTML + CSS + ES-module JavaScript, with hand-rolled inline SVG charts. No bundler, no CDN, works offline. (Vite + Preact is a possible later upgrade if the UI grows.)
- **Browser open:** platform command (`open` / `start` / `xdg-open`).

Net new runtime dependencies beyond the notifier: none required. Everything else is Node built-ins.

## File layout

```
claude-code-cockpit/
├── .claude-plugin/
│   ├── plugin.json              # plugin manifest
│   └── marketplace.json         # single-plugin marketplace entry
├── hooks/
│   └── hooks.json               # event → command wiring
├── commands/
│   ├── open.md                  # /cockpit:open
│   ├── status.md                # /cockpit:status
│   └── stop.md                  # /cockpit:stop
├── scripts/
│   ├── emit.js                  # hook entry: parse stdin, append event, ping daemon, exit 0
│   ├── ensure.js                # SessionStart: idempotent deps + spawn daemon if down
│   ├── ensure-deps.js           # idempotent npm install (reused pattern)
│   ├── daemon.js                # long-running server: aggregate + http + sse + notify
│   ├── aggregate.js             # PURE: events → session state + per-repo rollups
│   ├── transcript.js            # version-tolerant transcript adapter → token usage
│   ├── repo.js                  # PURE-ish: cwd → git root, name, branch (no subprocess)
│   ├── pricing.js               # PURE: tokens + model → estimated cost
│   ├── notify.js                # node-notifier wrapper (detached worker, reused)
│   ├── config.js                # read / merge / write / validate config (reused pattern)
│   ├── paths.js                 # XDG/APPDATA dirs + port/pid/snapshot paths (reused)
│   └── *.test.js                # node --test unit tests for the pure modules
├── web/
│   ├── index.html               # dashboard shell
│   ├── app.js                   # SPA: consumes /api/state + SSE, renders views
│   ├── charts.js                # inline-SVG chart helpers
│   └── styles.css
├── package.json
├── .gitignore                   # node_modules/
├── README.md
└── docs/
    ├── CONCEPT.md
    └── ARCHITECTURE.md
```

**Pure, unit-testable modules** (`aggregate.js`, `repo.js`, `transcript.js`, `pricing.js`) mirror the notifier's split of a testable core (`buildNotification`) from thin I/O entry points.

## Hook wiring (`hooks/hooks.json`)

Every command is `node "${CLAUDE_PLUGIN_ROOT}/scripts/emit.js"`, except `SessionStart`, which *also* runs `ensure.js`. `${CLAUDE_PLUGIN_ROOT}` is the plugin's install directory (confirmed via Claude Code docs).

| Event | Why we listen | Drives |
| --- | --- | --- |
| `SessionStart` | Register session; capture `source`, `model`, `cwd` | Session created; also triggers `ensure.js` |
| `UserPromptSubmit` | A prompt begins (has `prompt_id`) | Status → `running`; start prompt timer |
| `PreToolUse` (`emit.js`) | Claude is about to use a tool (`tool_name`) | Live activity ("running Bash", "editing…") |
| `PreToolUse` (`gate.js`) | Blocking pause gate | Reads control file; blocks tool if paused and `pauseGateEnabled` |
| `PostToolUse` | Tool finished | Clear/advance activity; refresh `lastActivityAt` |
| `Notification` | Claude needs input (`notification_type`) | Permission prompt → status `waiting`. `idle_prompt` normally leaves status unchanged (turn already `idle` from `Stop`), settling a running session to idle only when nothing's in flight |
| `Stop` | Turn finished (`stop_reason`) | Close prompt; add duration + tokens to repo rollup |
| `StopFailure` | Turn ended on an API error | Status → `error`; optional notification |
| `SubagentStart` / `SubagentStop` | Subagent lifecycle (`agent_type`) | Subagent counters / labels |
| `SessionEnd` | Session terminates (`reason`) | Finalize session; move to history |

Deliberately **not** hooked: `MessageDisplay` (fires per streamed text chunk — far too high-volume). `PostToolUse` can also be frequent when Claude loops, so the daemon **debounces** UI pushes derived from it (see below). Matchers can scope tool hooks later if needed; v1 listens to all tools.

## Event model & storage

`emit.js` is the only code that runs inside a hook. It:

1. Reads the JSON payload from stdin (tolerant of empty/garbage input).
2. Resolves the repository cheaply (see `repo.js`) — **no subprocess**, just a filesystem walk.
3. Appends **one normalized JSON line** to `stateDir/events/YYYY-MM-DD.jsonl` with a single bounded `write()` on a handle opened `'a'`. (A single small-line append is atomic on local filesystems, but that isn't guaranteed on every platform/FS, so the daemon's reader **tolerates and skips a torn final line**.)
4. Fires a **best-effort** `POST /internal/event` to the daemon (port read from `stateDir/cockpit.port`) with a very short timeout. **This POST is a wake-up nudge only — it carries no authoritative data.** The daemon always ingests from the log itself, keyed by byte offset, so a POST can never cause double-counting and a dropped POST loses nothing.
5. Swallows every error, logs to stderr, and `process.exit(0)`.

The daemon is *not* on the hook's critical path: the log is the durable source of truth, the byte offset of each line is its **idempotency key**, and the POST only shortens the latency before the daemon reads the next line. If the daemon is down, events are still persisted and read when it next starts.

**Normalized event record** (fields present depend on the event):

```json
{
  "ts": "2026-07-02T10:15:30.123Z",
  "event": "UserPromptSubmit",
  "session_id": "…",
  "owner_pid": 42421,
  "prompt_id": "…",
  "cwd": "/Users/me/code/acme-api",
  "repo_root": "/Users/me/code/acme-api",
  "repo_name": "acme-api",
  "branch": "main",
  "transcript_path": "/Users/me/.claude/projects/…/<session>.jsonl",
  "permission_mode": "default",
  "effort_level": "medium",
  "model": "claude-sonnet-5",
  "tool_name": "Bash",
  "notification_type": "permission_prompt",
  "stop_reason": "end_turn",
  "agent_type": "Explore"
}
```

**Repository resolution (`repo.js`)** — from `cwd`, walk parent directories to the nearest `.git` (directory *or* file, to support worktrees and submodules); `repo_root` is **that directory**, `repo_name` is its basename, and `branch` is read directly from `.git/HEAD` (a cheap file read). No `git` subprocess is spawned, keeping `emit.js` fast. Results are memoized per invocation.

> **This deliberately avoids the `claude-code-notifier` bug.** The notifier derives its title with `path.basename(cwd)` alone, so launching Claude Code from a **subdirectory** of a repo (e.g. `cwd = /me/acme-api/packages/worker`) shows the subfolder name (`worker`) instead of the repository (`acme-api`). Walking up to the git root fixes this. Fallback: if **no** `.git` is found on the way up (the session isn't in a git repo), `repo_root = cwd` and `repo_name = basename(cwd)` — matching the notifier's behavior only in the case where there is genuinely no repo to name. `repo.js` is the canonical implementation of this rule; see the note at the end of this document about back-porting it to the notifier.

**Retention & rotation:** events are written to per-day files, which rotate naturally at midnight. **The daemon never deletes anything automatically** — there is no retention timer and no size cap. Cleanup is entirely manual: `POST /api/data/cleanup` unlinks whole **inactive past-day** files older than a user-chosen age, and `POST /api/repos/delete` removes one repository's data (see *Manual data management* below). The automatic pruner **never truncated or renamed the current day's file**, which hook processes may be appending to concurrently (doing so races the writers and drops lines); that invariant is now bent only by the deliberate, one-shot per-repo delete, which drains the tail and resets the byte offset before rewriting today's event log (see below).

**Derived time-series & rollups (daemon-owned).** The event log above is hook-written (many short-lived processes appending concurrently — see the append-safety note above). The daemon owns two further stores, so each has exactly **one writer** and there is no cross-process contention:

- `stateDir/usage/YYYY-MM-DD.jsonl` — one **timestamped token-usage record per closed turn**: `{ ts, session_id, repo_root, model, input, output, cacheRead, cacheWrite }`, written when the daemon computes a turn's token delta at `Stop`. This is what makes *tokens-over-time* graphs possible; the live totals alone hold only current sums. (Tokens/prompts/cost derive from this log; **active time does not** — see *Active-time accounting*.)
- `stateDir/rollups/YYYY-MM-DD.json` — a **materialized daily aggregate** per repo (active ms, prompt/session counts, tokens by model, estimated cost), updated incrementally as events and usage records arrive.

**Manual data management (daemon-owned deletes).** Three authenticated endpoints let the dashboard report and reclaim disk, replacing the removed auto-pruner:

- `GET /api/storage` — the store's on-disk size (the `events`/`usage`/`rollups` dirs + `snapshot.json`, excluding `daemon.log`) plus its day span, computed synchronously per request and **never** on the SSE broadcast path (`buildStatePayload`), so it can't slow live updates.
- `POST /api/data/cleanup {olderThanDays:N}` — unlinks every whole day-file older than *today − N* (never today's), across the three dirs; the safe subset of the old pruner (whole-file unlinks, no concurrent writers). Clears the rollup and all-time caches.
- `POST /api/repos/delete {repoRoot}` — hard-deletes one repo across every usage/event/rollup day-file (unlinking any emptied file so the store actually shrinks). Refuses with **409** if a live session still owns the repo (its in-flight events would otherwise re-populate it). For today's event log — the one file hooks append to — it drains the tail (`tailOnce`), rewrites the file without the repo, then **resets `offsets[currentDate]` to the shrunk size** and persists it, so the next tail can't mistake the smaller file for a truncation-restart and re-read every surviving line (which would double-count the other repos' live state).

Together the event log (timing, activity, status) and the usage log (tokens) are the complete **timestamped time-series**; the daily rollups are the fast read path over it, so a `GET /api/history` chart query is O(days-in-range) rather than a full-log replay. Everything is plain JSON — no database — preserving the zero-native-dependency, zero-build property. If range queries ever outgrow this (very long histories, ad-hoc SQL), the same structured records migrate cleanly into SQLite (`node:sqlite` built-in, or `better-sqlite3`) behind the store interface without touching the rest of the daemon.

**Active-time accounting.** "Active time" is **engaged wall-clock**, derived from the **event log** (not from turn durations or the usage log). A session is *engaged* while it is `running` a turn **or** has a subagent/workflow agent in flight; it is *not* engaged while `waiting` on a permission prompt or `idle`. An incremental clock in `aggregate.applyEvent` (the `engagedSince` anchor) sums these spans into the live per-session `activeMs`; the same `applyEvent` replayed over a day's events (`accumulateActiveFromEvents`) produces the per-repo/day rollup and the by-hour histogram — so live, per-repo, and History figures share one definition and cannot diverge. Because active time is a **pure function of the durable, replayed event log**, it is inherently crash-safe (a restart re-derives identical values — no separate persistence, no idempotency key). Two consequences: (1) this excludes permission/idle waits and **includes background-workflow time** (whose `workflow-subagent` `SubagentStart`/`SubagentStop` arrive on the parent session after the launching turn's `Stop`); (2) it **cannot** count a background **`Bash`** (`run_in_background`), which spawns no subagent and so emits no hooks while it runs. The clock is hardened against a missing/unparseable timestamp (it stops the span rather than later settling the idle gap) and a backward/out-of-order timestamp (it never re-anchors backward).

**Day boundaries & the snapshot-vs-rescan seam.** An engaged span is *broken* at day rollover (the daemon nulls each session's `engagedSince` in `rolloverDay`, and on a stale-day restart in `loadSnapshot`) so the live per-repo total and the fresh per-day re-derivation agree — the cost is that a span still engaged across midnight loses the slice between its last pre-midnight and first post-midnight event. Backfilled history has no events, so it contributes tokens/cost but no active time. One **known transient edge** remains: the live per-session `activeMs` is fast-started from the snapshot plus a partial replay, whereas the rollups are re-derived by a full-day event rescan — so right after a restart the two can briefly disagree in narrow cases (an event appended during the boot read window; a same-day upgrade from a pre-`engagedSince` v0.4.0 snapshot; a boot straddling local midnight). It self-corrects on the next restart's re-derivation; fully unifying the fast-start and rescan paths is a deferred follow-up.

## Pause gate (`scripts/gate.js` + `scripts/pause.js`)

A **separate blocking `PreToolUse` hook** runs in parallel with `emit.js`, polling a control file (`stateDir/cockpit.pause`) and blocking tool execution if it holds a paused sentinel (`paused` = manual, `paused-usage` = auto). The gate is **opt-in** (`pauseGateEnabled` config), **fail-open** (missing/garbage file → tools run), and **fail-safe-deny** (blocks up to ~24h before explicitly denying to avoid silent hang). Pause/resume transitions are recorded in the event log as `Paused` / `Resumed` events with a `reason` field (`'manual'` or `'usage'` for auto-pause); the daemon folds these into a global `paused` state and accumulated `pausedMs`. Control-file reads are the source of truth — chat prompts cannot resume a paused session, only the file (or the dashboard / slash commands that write it) can. An optional **auto-pilot** pauses when 5-hour rate-limit usage crosses a threshold and resumes when the window resets, reusing the rate-limit data the statusline already feeds the daemon (entry 42). The daemon surfaces `POST /api/pause`, `/cockpit:pause` / `/cockpit:resume` commands, a dashboard Pause/Resume button, a global **PAUSED** banner with live paused duration, and a statusline `⏸ PAUSED` segment. **Known limitation:** a session blocked mid-tool-call during a pause counts the frozen wait as active time; pause-aware clock is deferred.

## The daemon (`daemon.js`)

### Lifecycle & singleton

- **Start / revive:** `ensure.js` runs on every `SessionStart`. It ensures dependencies are installed (idempotent), then — as a fast path only — checks whether a daemon answers `GET /health`. **Singleton-ness is *not* enforced by that check:** two concurrent `SessionStart`s could both see no daemon and both spawn one (a TOCTOU race). Instead, **the daemon guarantees singleton on its own startup by acquiring an exclusive lock** — `fs.open(cockpit.lock, 'wx')` (or an exclusive bind of the listening socket) held for its lifetime; a daemon that loses the race logs and exits. `ensure.js` spawns it **detached** (`spawn(node, [daemon.js], { detached: true, stdio: 'ignore', windowsHide: true }).unref()`; `windowsHide` stops a console window flashing on Windows).
- **Port:** prefer a stable default (`4319`) so the dashboard URL is durable across restarts. An ephemeral port is used only if the default is taken, recorded in `stateDir/cockpit.port`; **an ephemeral port disables idle-shutdown** so a revived daemon never returns on a URL that open tabs can't find. **Bind `127.0.0.1` only.**
- **Crash recovery:** a crashed daemon is revived on the next `SessionStart` — no supervisor needed. `GET /health` reports the daemon's **version and plugin path**, so after a plugin upgrade `ensure.js` can detect an old-code daemon and replace it.
- **Idle shutdown:** optional, and only on the stable default port. If `idleShutdownHours > 0`, exit after that long with no active sessions and no connected dashboard clients. Default `0` = stay resident (it is lightweight).
- **Manual stop:** `/cockpit:stop` signals the pid to exit.

### State rebuild on startup

On boot the daemon treats the **event and usage logs as the sole source of truth** and rebuilds derived state from them. `stateDir/snapshot.json` (active-session state + last-processed log offsets) is only a fast-start optimization: the daemon resumes from it, then **re-derives the current (open) day's rollup directly from that day's logs** rather than trusting a possibly mid-write rollup or snapshot — cheap, since a day's logs are small. Past days' rollups are **derived on demand from their usage logs** (the single source of truth), not trusted as frozen files: token usage is attributed to the day each message was actually spent (from its transcript timestamp), and **historical backfill** — the first ingest of a long-running or resumed session's prior work — simply appends timestamped, message-id-keyed usage records to the relevant day's log (a session's counted-id set is re-seeded from those logs before ingest, so a whole-transcript re-read never re-appends). Because a day's rollup is a pure function of its usage log, backfill is idempotent and crash-safe — a restart, a resume, a corrupt rollup file, or a crash mid-write can neither double-count nor lose tokens. This makes an ungraceful crash safe: replay is **idempotent on the log's byte offsets**, so tokens/time are never double-counted or lost. The **stale-session reaper** (below) finalizes sessions whose owning process is gone — handling the case where `SessionEnd` never fires because Claude Code was force-quit.

### Live state machine (per `session_id`)

```
SessionStart(source, model) → register { repo, cwd, model, startedAt, status: idle }
UserPromptSubmit(prompt_id) → status: running; currentPrompt = { promptId, startedAt }; prompts++
PreToolUse(tool_name)       → status: running; currentActivity = tool_name; lastActivityAt = now
PostToolUse                 → advance/clear currentActivity; lastActivityAt = now      (debounced)
Notification(permission…)   → status: waiting          (blocked on the user)
Notification(idle_prompt)   → "done, awaiting next prompt": normally a no-op (already idle from Stop),
                              but settles a still-running session to idle when nothing is in flight
                              (guards a lost Stop; skipped while a subagent/tool is active so a
                              mid-turn idle_prompt can't falsely idle a working session)
Stop(stop_reason)           → close currentPrompt; duration = now − promptStartedAt;
                              add duration + token delta to repo rollup; status: idle;
                              refresh tokens; evaluate notifications
StopFailure(reason)         → status: error(reason); evaluate notification
SubagentStart/Stop          → subagent counters + labels
SessionEnd(reason)          → finalize session; move to history; drop from active set
```

`PostToolUse`-driven UI updates are **coalesced** (≤ ~4 pushes/sec/session) so a tool-looping session can't flood the SSE stream.

**Stale-session reaper.** `SessionStart` records the hook's parent PID (`process.ppid` — the Claude Code process, or its launching shell) as the session's owner. The reaper marks a session `ended (stale)` **only when that PID is no longer alive** (best-effort `process.kill(pid, 0)`), *not* merely when events have gone quiet — so a long, silent `Bash`/build that emits no events for minutes is never falsely reaped out from under its `longRunning` notification. If the owner PID is unknowable, it falls back to a generous idle timeout.

### Elapsed timers

The daemon pushes **state transitions with server timestamps**; the browser computes the ticking `elapsed = clientNow − promptStartedAt` locally each second. This keeps timers smooth even when no events are flowing. Each snapshot includes the daemon's `now` so the client can correct for clock drift.

## Token usage ingestion (primary design risk)

**Source:** the session transcript JSONL at `transcript_path`. Assistant messages carry a `usage` object (`input_tokens`, `output_tokens`, `cache_creation_input_tokens`, `cache_read_input_tokens`) and a per-message `model`. That per-message `model` is also the daemon's fallback for a session's *displayed* model: `SessionStart` is the only hook that carries `model` and it may omit it (so a resumed session, or one first seen after a snapshot loss, would otherwise show no model), so on each usage read the daemon backfills `session.model` from the transcript's most-recent assistant message.

> **Risk — transcript schema is not a stable contract.** Claude Code's own documentation states the transcript entry format is *internal and changes between versions*, and that mid-turn writes may not be flushed. The exact `usage` field names were confirmed by convention but **not** guaranteed by docs. Direct parsing can therefore break on a Claude Code upgrade.

Mitigations, all concentrated in `transcript.js` behind a stable internal interface `readUsage(session) → { byModel, totals }`:

- **Version-tolerant parsing.** Tolerate unknown fields, missing `usage`, and schema drift. Skip unparseable lines. **Never throw into the daemon.**
- **Read at safe points, with a flush retry.** Read on `Stop` and `UserPromptSubmit`, plus a low-frequency poll — never mid-turn. The transcript is flushed *asynchronously*, so the final turn's `usage` may not be on disk the instant `Stop` fires; if the expected new usage is missing, **retry with short backoff (up to ~1–2 s)** before giving up rather than recording a wrong zero.
- **Incremental tail.** Track a per-session file offset (and a last-line hash); read only appended lines and sum the delta.
- **Idempotent, id-keyed attribution.** Key each usage record by the transcript **message id/uuid**, not just append position, so retries, resumes, and re-reads can't double-count, and multi-model turns attribute per message. Where the owning prompt/model can't be resolved confidently (resume, subagent, compaction), **mark the record uncertain** and keep it out of the exact cost rollups rather than folding in a guess.
- **Graceful degradation.** If parsing yields nothing or errors, fall back to **time-only** accounting for that session and mark tokens as *unavailable* in the UI rather than showing a wrong zero.
- **Swappable source.** Because ingestion sits behind one interface, a more stable future source — Claude Code's `/export` or its documented script/SDK session interfaces — can replace transcript parsing without touching the rest of the daemon.

**Attribution & persistence:** each turn's token delta is attributed to its session's `(repo_root, model)`, **persisted as a timestamped usage record keyed by transcript message id** (see *Derived time-series & rollups*), and folded into both the live per-repo totals and the day's rollup. Per-repo totals aggregate across models. Persisting the delta — rather than only incrementing an in-memory counter — is what lets the History view chart tokens over time and lets those numbers survive a daemon restart.

## Cost estimation (`pricing.js`)

A pure function over a **configurable pricing table**: `model → { input, output, cacheRead, cacheWrite }` in USD per million tokens. `cost = Σ tokens × rate`, always labelled an **estimate**. Config can override rates, change currency, or disable cost display entirely. An **unknown model** renders as `—` (never `$0`) with a "no rate configured" note, so missing rates are visible rather than silently wrong.

## Notifications & sounds

**OS notifications are emitted by the daemon, not by the browser** — this is the crux of the design. The daemon is the always-on component (spawned and revived by `SessionStart`, so it is up during any active session), whereas the dashboard is a purely optional client. Consequently the OS-notification path — and its sound — works **whether or not a browser tab is open**. We deliberately do *not* use the browser's Web Notifications API for this, because that would only fire when a tab happened to be open, defeating ambient awareness. In-browser Web Audio cues are the only notification channel that requires an open tab.

| Channel | Emitted by | Needs an open browser tab? |
| --- | --- | --- |
| OS notification banner | daemon → `node-notifier` | no |
| OS notification sound | daemon → `node-notifier` `sound` | no |
| In-browser sound cue | dashboard → Web Audio | yes |
| Live cards / timers / charts | dashboard | yes |

`notify.js` wraps `node-notifier` using the notifier's **detached-worker** dispatch so notification I/O never blocks the daemon's event loop.

- **Configurable events** (`config.events`): `sessionFinished` (Stop), `needsInput` (permission `Notification`), `longRunning` (a prompt exceeds `longRunningThresholdMs`, evaluated by a daemon timer), `turnFailed` (`StopFailure`). Each independently on/off.
- **OS integration is opt-in** — a master `osNotifications` toggle plus the per-event toggles — satisfying the "hook into the OS notification system *if the user chooses*" requirement.
- **Sound, two independent channels:** the OS notification sound (`node-notifier`'s `sound`, reusing the notifier's `true` / `false` / named-macOS-sound semantics), and **in-dashboard Web Audio cues** (distinct tones per event, played only when a dashboard tab is open). Each channel toggles separately.

## Dashboard (`web/`)

Static files served by the daemon. The SPA loads an initial snapshot from `GET /api/state`, then subscribes to `GET /api/stream` (SSE) for deltas; charts pull from `GET /api/history?range=…`. **SSE** is chosen over WebSockets because updates are one-way (server → client) and it reconnects automatically. To survive sleeps, network hiccups, and daemon restarts without silently drifting stale, the stream sends periodic **heartbeats** and an `id:` on every event, and on any reconnect the client **re-fetches `GET /api/state` for a full resync** rather than assuming it missed nothing. After prolonged connection loss (e.g. an idle-shut-down daemon) the UI shows a *"connection lost — run /cockpit:open"* state instead of silently hammering a dead port. No external assets — fully offline.

**Canonical stat-column order.** Every surface that shows the per-entity accounting stats lists them in one shared sequence: **Tokens · Cost · Sessions · Chats · Tools · Agents · Active · Last active** (where *Chats* is the display label for the prompt count and *Agents* for subagents). Each surface renders the subset that applies to it, in this relative order, and omits the rest — it never re-orders. The two ways a value drops out: **Sessions** is omitted on any single-*session* surface (a session isn't a collection of sessions — the Live card and the Sessions-table row both omit it); **Cost** drops out on every surface when cost display is disabled; and the **live** surfaces (the Live ribbon and cards) omit **Last active** because status + the ticking timer already convey currency. Concretely: the Live ribbon = Tokens·Cost·Sessions·Chats·Tools·Agents·Active; the Live card = Tokens·Cost·Chats·Tools·Agents·Active (its muted repo-total second row mirrors the same columns); the Repos table = Repository + Tokens·Cost·Sessions·Chats·Tools·Agents·Active·Last active; the Sessions table = Name·Repo + Tokens·Cost·Chats·Tools·Agents·Active·Last active. Keeping one order means a value always sits in the same relative place whichever page you're on.

**Views:**

- **Live:** a card grid, one card per active session — repo name, branch, path (click-to-copy), status badge, current activity, the ticking prompt timer, session age, tokens so far, the session's **active time** (see *Active-time accounting* below — engaged wall-clock, excluding permission/idle waits, including background-workflow time; distinct from wall-clock age), and `permission_mode` / `effort` chips. Each card also shows the **repo's all-time cumulative total** (prompts + tokens + active time + estimated cost) as a muted second row aligned under the per-session stat columns, distinct from the per-session numbers above — the daemon supplies it as a `repoTotals` map (keyed by `repoRoot`) on `/api/state`. `waiting` sessions sort to the top and are highlighted.
- **Repos:** a sortable table in the canonical column order — Repository, then tokens, estimated $, sessions, chats (prompts), tools, agents (subagents), active time, last active — with a range filter (today / 7d / 30d / all). Sorting resolves by column *key*, so the shared ordering is display-only and the default (active-time descending) is unaffected.
- **History:** a flat, full-width list of eight inline-SVG charts (no grouping, headers, or pivot), served from one enriched `GET /api/history?range=…` payload. Three **dual-axis** line charts — *Tokens & cost per day*, *… per active hour*, *Tokens per chat* — plot two self-scaled axes (tokens left, cost right) plus quiet **dotted, axis-less correlation lines** (chats & avg-context, or tools & active-time) read for *shape*, with real values in the tooltip; *Cost per day, by type* is a stacked chart (chosen over tokens-by-type because token counts are ~all cache-read/flat, while *cost* splits meaningfully — output is ~50× cache-read per token); and four instrument charts — a **day×hour punchcard**, a **calendar heatmap**, and horizontal-bar *Subagents by type* & *Tool usage*. The `perDay` entries carry per-group breakdowns (`byModel`/`byRepo`/`byTool`/`byAgentType`/`costByType`, priced server-side) plus a top-level `byDowHour` 7×24 matrix (which replaced `byHour`); the client reads a curated subset of this one payload, so only a range change refetches. Charts render at the card's real pixel width (crisp, not CSS-scaled). Still no full-log scan (pre-bucketed daily rollups). *(An earlier iteration had ~15 charts grouped into families plus an interactive Measure×Group pivot; both were dropped — for single-model, cache-dominated usage most of those charts and the pivot's model/token-type splits flattened out, so the view was pared to the high-signal set above. The daemon still emits the full breakdowns, leaving the pivot re-addable.)*
- **Sessions:** a newest-first, paginated table of *every* Claude Code session still on disk, served by `GET /api/sessions?page=&pageSize=` (pageSize default 50, clamped `[1,100]`). Its source is the **transcript filesystem** (`~/.claude/projects/<encoded-cwd>/*.jsonl`, enumerated exactly as backfill does), **not** the cockpit's store: it `statSync`s every transcript to sort by mtime (newest first) and count the exact `total`, then parses only the ~pageSize files on the requested page (each transcript is one row, none dropped). Names come from the transcript `ai-title` (via `readUsage`'s added `title`); the verbatim `last-prompt` is **never** surfaced — the privacy boundary this view draws. Cost is bounded by a ~3s stat/sort snapshot plus a per-file (mtime/size-keyed) parse cache, so the O(total) sweep never runs on the SSE path. Live rows are marked active by a client-side overlay intersecting `sessionId` with the streamed live set. The row's **tokens/cost come from the transcript**; its **Active, Chats, Tools, and Agents columns are EVENT-derived** — sourced from the same live state / event-log replay the Live card and Repos table use (never counted from the transcript, whose raw prompt/tool counts diverge from the cockpit's event counts and would contradict every other page). A live session reads its authoritative live counters; a past session the cockpit observed reads a per-session event-log index (`accumulateSessionStatsFromEvents`, memoized per past day and summed under the snapshot TTL, alongside active time); a session the cockpit never observed (pre-install / transcript-only, or whose event days were cleaned up) shows **"—"** for all four — never a misleading 0 (an observed-but-idle session correctly shows 0). **Consequence:** because it reads Claude Code's transcripts, it follows *Claude Code's* retention, not the cockpit's — a repo deleted via `/api/repos/delete` (or days pruned via `/api/data/cleanup`) still lists its sessions here.
- **Settings:** the **single place all configuration is edited** — sound selection, the OS-notification master toggle, OS vs. in-browser sound toggles, per-event notification toggles, the activity-detail level (`activityDetail`: tool name only vs. arguments), the long-running threshold, and the pricing table. It also hosts a **Data** section (not config-backed) showing the on-disk store size + day span from `GET /api/storage` and a manual "clean up data older than N days" control (`POST /api/data/cleanup`) whose confirm previews the scope — there is no automatic retention. Editing a *config* control issues `PUT /api/config`; the daemon validates it, persists it via `config.js`, hot-reloads its in-memory config, and broadcasts the new config over SSE so every open dashboard reflects the change immediately.

## Configuration

Reuses the notifier's `paths.js` / `config.js` pattern with `APP_NAME = "claude-code-cockpit"`. Config lives at `configDir/config.json`; runtime state (event log, usage log, daily rollups, snapshot, port/pid files, daemon log) lives under `stateDir`.

```json
{
  "port": 4319,
  "osNotifications": true,
  "sound": true,
  "browserSounds": true,
  "activityDetail": "tool",
  "events": {
    "sessionFinished": true,
    "needsInput": true,
    "longRunning": false,
    "turnFailed": true
  },
  "longRunningThresholdMs": 300000,
  "cost": {
    "enabled": true,
    "currency": "USD",
    "rates": {
      "claude-sonnet-5": { "input": 3, "output": 15, "cacheRead": 0.3, "cacheWrite": 3.75 }
    }
  },
  "idleShutdownHours": 0
}
```

**All configuration is edited in the dashboard's Settings view** (see above), through `GET`/`PUT /api/config`. There is intentionally **no TTY wizard** — the UI is the single, discoverable place to change settings, which is why the `prompts` dependency and a `/cockpit:configure` command are absent from this design. `config.json` remains a plain, hand-editable file as a fallback for headless setups, but the dashboard is the intended editor. `config.js` owns read / merge / **validate** / write so that both the daemon's boot-time load and the `PUT /api/config` handler share one schema and one set of defaults; an invalid `PUT` is rejected and the on-disk config is left untouched.

## Commands (`commands/*.md`)

- **`/cockpit:open`** — ensure the daemon is up, then print/open the dashboard URL (`open` / `start` / `xdg-open`). All configuration lives in the dashboard's Settings view, so this command is also the path to change settings.
- **`/cockpit:status`** — a quick text summary: daemon health, dashboard URL, count of active sessions.
- **`/cockpit:stop`** — stop the daemon.

## Cross-platform considerations

- **Paths** via `paths.js` (XDG on macOS/Linux, APPDATA/LOCALAPPDATA on Windows).
- **Detached daemon** uses `detached: true, stdio: 'ignore', windowsHide: true`. The notifier's fire-and-forget *worker* proves the spawn mechanism, but an always-on *server* is more demanding — so daemon survival across logout, shell exit, and plugin upgrade (and Windows process-group/console behavior) is a **named per-platform test target**, not an assumption.
- **Binding** is always `127.0.0.1` — never `0.0.0.0`.
- **Browser open** uses the platform-appropriate command.
- **`node-notifier`** bundles the platform helpers; Linux still needs a working `notify-send`.
- **No reliance on `fs.watch` for correctness** (its behavior varies by OS and filesystem) — liveness comes from the hook POST plus periodic reconciliation; `fs.watch` is at most a bonus.

## Security & privacy

- **Localhost bind is not, by itself, access control.** The daemon binds `127.0.0.1`, but that still lets *any* local user on a shared machine and *any* web page in the user's browser reach the endpoints. So every endpoint — `/api/*`, the SSE stream, and `/internal/event` — **requires an unguessable bearer token** the daemon generates at startup and writes to a `0600` file under `stateDir` (readable only by the owner); the dashboard and hooks read it from there. Requests with an unexpected `Origin`/`Host` are rejected, blocking drive-by browser and DNS-rebinding calls. LAN exposure stays off (bind is localhost-only, never `0.0.0.0`).
- **No message text, ever.** Transcript / prompt / response content is never stored or served — only token counts, tool *names*, and metadata. The Live view always shows the tool **name** ("Running `Bash`", "Editing a file"). Richer **tool-argument** detail (the current file path or command fragment, truncated) is a separate, **default-off** setting (`activityDetail`), shown locally only — because those arguments can contain paths or secrets. Off by default keeps the hard guarantee intact; turning it on is an explicit, local-only choice.
- **Data location is documented** (`stateDir`) along with how to clear it.

## Failure isolation

- Every hook script wraps its work in try/catch, logs to stderr, and **exits 0** — a hook can never block or fail a Claude Code session. This is the same hard guarantee the notifier provides.
- Hooks do **not** depend on the daemon being up; the event log is the source of truth.
- The transcript parser never throws into the daemon; malformed lines are skipped.

## Testing

- **Unit (`node --test`)** on the pure modules: `aggregate.js` (event sequences → expected state and rollups), `repo.js` (cwd fixtures → root / name / branch), `transcript.js` (sample JSONL → usage, including malformed and version-drifted lines), `pricing.js` (tokens + model → cost, including unknown models).
- **Daemon integration:** feed synthetic events via `POST /internal/event` and assert `GET /api/state`.
- **Smoke:** pipe fake payloads into `emit.js` (e.g. `printf '{"hook_event_name":"Stop","cwd":"%s"}' "$(pwd)" | node scripts/emit.js`).
- **Manual cross-OS** verification: macOS primary; Windows and Linux as environments are available (matches the notifier).

## Risks & open questions

- **Transcript schema stability (highest risk)** — mitigated by the `transcript.js` adapter + graceful degradation; revisit if/when Claude Code exposes a stable usage API or `/export` becomes scriptable here.
- **Token flush timing / accuracy** — reads happen only at safe points; totals are explicitly best-effort.
- **Concurrent and resumed sessions** — `session_id` is unique per session; a resumed session reuses its `cwd` and transcript; the reaper covers a missing `SessionEnd`.
- **Daemon lifecycle edge cases** — port conflicts (ephemeral fallback), multiple OS users on one machine (per-user `stateDir`), and **headless/SSH sessions** where OS notifications have nowhere to render (documented caveat — the dashboard still works via port-forwarding, but desktop notifications may not).
- **Cost accuracy** — an estimate only; rates drift and are user-editable.
- **Multi-machine** — explicit non-goal for v1; `repo_root` keys are machine-agnostic, so a future `machine_id` dimension could enable aggregation without reworking the model.

## Suggested phasing

1. **v0.1 — Live view.** Hooks + `emit.js` + daemon + live session cards (status, timers, activity) + `/cockpit:open`.
2. **v0.2 — Accounting.** Token ingestion (`transcript.js`) + per-repo rollups + estimated cost.
3. **v0.3 — History & alerts.** Retained history + charts + configurable notifications/sounds + the Settings UI (`GET`/`PUT /api/config`).

## Appendix — back-porting repo resolution to `claude-code-notifier`

The notifier has a known bug: its notification title is `path.basename(cwd)`, so a session launched from a subdirectory shows the subfolder name rather than the repository name. `repo.js` here is the fix, and its logic (walk up to the nearest `.git`; fall back to `basename(cwd)` only when there is no repo) is worth back-porting to the notifier so both plugins name repositories identically.

Note the small design tension when doing so: the notifier's `buildNotification(payload)` is a **pure** function, which is what makes its unit tests trivial. Git-root resolution touches the filesystem, so a back-port should keep the resolution in a separate helper (e.g. `resolveRepoName(cwd)`) that `buildNotification` receives as an argument or calls through an injectable seam — preserving the pure, testable core while fixing the naming. That helper and this `repo.js` should ideally be the same implementation.
