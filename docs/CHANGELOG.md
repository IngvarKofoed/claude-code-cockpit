# Changelog

Each entry is numbered with a monotonically increasing integer. Append new entries to the end. Never reuse or reorder numbers. Numbers are globally unique across this file and any future `CHANGELOG-archive.md` — never reused. Write each entry as durable project memory: what is now true that wasn't before, plus the why in a clause when not obvious — not a recap of the diff (filenames and mechanical edits live there). Keep it to 1–5 lines, ~20 words per line at most; never one packed run-on line.

1. Metrics store is timestamped JSONL, not a database: a hook-written event log plus a daemon-written per-turn token-usage log, over materialized daily rollups.
   Token deltas are persisted (not just counted in memory) so history graphs can chart tokens over time and survive daemon restarts.
   SQLite was rejected for now to keep the zero-native-dependency property; it stays a migration path behind the store interface.

2. Design hardened after an external review (Codex GPT-5.3 + Gemini 3.1 Pro), before any code exists.
   Daemon singleton is an exclusive OS lock, not a health-check (avoids TOCTOU double-spawn); logs are canonical with byte-offset idempotency and the open day's rollup rebuilt on boot (crash-safe).
   All HTTP/SSE/internal endpoints require a 0600 bearer token + Origin check — localhost bind alone isn't access control on shared machines.
   Transcript reads retry for async flush and key usage by message id; stale-reaper keys off the owning PID; SSE resyncs via /api/state on reconnect.
   Activity-argument detail (file path / command) is now default-off (`activityDetail`) to preserve the "no message content" guarantee; tool names are always shown.

3. Full v0.1–v0.3 implementation landed: hook `emit.js`, `ensure`/`ensure-deps`, the always-on `daemon.js`,
   the pure core (`aggregate`/`transcript`/`repo`/`pricing`), `config`/`paths`/`notify`, the buildless web SPA
   (Live/Per-repo/History/Settings over SSE), the `/cockpit:*` commands, and plugin wiring.
   Plugin is named `cockpit` (so commands resolve to `/cockpit:*`); `paths.APP_NAME` stays `claude-code-cockpit`.
   82 unit tests pass; daemon verified end-to-end (auth enforced, token ingestion, pricing, restart idempotency).
   Confirmed via docs: `StopFailure`/`SubagentStart`/`PostToolUseFailure` are real hooks; `effort.level` is nested;
   `Notification` carries `notification_type`; commands namespace off the plugin name.

4. Accounting made crash-safe after two adversarial review passes. Now true:
   day-rollover drains the outgoing day's log before freezing it (a turn logged just before midnight is no longer lost);
   `StopFailure` ingests the failed turn's tokens (not just `Stop`), so a rate-limited turn's cost isn't dropped;
   multi-model turns are priced per model (`accumulateTurnByModel` + a `byModel` usage record), fixing under-counting when a turn spans models;
   `seenIds` is persisted in the snapshot so a restart never re-counts already-billed messages even after usage logs are pruned.

5. Config/lifecycle hardening. Now true:
   port is bounded 1–65535 (an out-of-range port was persisted and crash-looped the daemon on listen);
   `retentionDays <= 0` means keep-forever (never prune), and a cleared numeric Settings field reads as its default not 0 — together they prevent silently wiping all history;
   the cost `rates` map is authoritative (replaces, not merges), so the Settings remove-button actually deletes a default model's rate;
   `ensure.js` replaces an old-version daemon (SIGTERM the old + the new daemon's lock acquisition retries until it releases);
   `owner_pid` is captured on every event (not only `SessionStart`) so the reaper works after a snapshot loss, and it now waits a 90s quiet grace before reaping a PID-dead session (guards a transient-shell `ppid`);
   `PostToolUse`/`PostToolUseFailure` restore `running`, so a session isn't stuck `waiting` after a permission is approved.

6. Known limitations / deferred follow-ups (not bugs, but do not "re-fix" as if new):
   `activityDetail: "args"` is accepted and shown in Settings but not yet wired — `emit.js` never stores tool arguments (privacy), so the control has no effect yet;
   `transcript.readUsage` re-reads the whole transcript each call — the architecture's incremental per-session-offset tail is deferred (correctness is fine; a cost only for very large transcripts);
   the reaper keys off `process.ppid`, whose meaning (Claude Code process vs. a launching shell) needs per-OS verification — the 90s grace mitigates a transient-shell false-reap;
   a stale session is dropped, not marked `ended (stale)` — acceptable while there is no session-history store to move it to.

7. Token usage is bucketed by the day each turn actually happened, not by ingest time.
   `transcript.js` surfaces each message's `timestamp`; on ingest the daemon groups a session's new messages
   by day — the latest-timestamp group is the completed turn (prompt + duration, correct even across a
   midnight boundary), earlier days are historical backfill (tokens/cost only, `accumulateTokensByModel`).
   Past days' rollups are DERIVED ON DEMAND from their usage logs (single source of truth), never persisted
   or amended in place, and each session's counted-id set is re-seeded from those logs before ingest — so
   backfill is idempotent and crash-safe (a restart, resume, or corrupt rollup file can't double-count or lose
   tokens). History/date-range views thus show real dates on a first ingest of a long-running/resumed session's
   prior work, instead of dumping it all into "today". Known limit: byHour for backfilled days is coarse (1 bucket/day).

8. New `/cockpit:backfill` command imports token usage from EXISTING on-disk transcripts — every past
   session for the current repo (default) or all repos (`{all:true}`) — via an authenticated
   `POST /internal/backfill`. The daemon resolves each transcript's repo from its recorded `cwd`
   (now surfaced by `transcript.readUsage().cwd`), buckets tokens by the real day, dedupes by message id
   (seeded from the usage logs), and SKIPS sessions it tracks live — so it is idempotent, re-runnable, and
   never double-counts. Backfilled turns contribute tokens/cost only (no prompt count / active time — a
   transcript can't reconstruct turn boundaries); coverage is bounded by `retentionDays`.

9. Live cards now show the repo's all-time cumulative total (prompts + tokens + cost) as a second row aligned
   under the per-session stat columns — each value sits under its matching per-session number, so the two
   rows compare straight down. It carries NO text label: the muted colour + dashed divider mark it as the
   repo total (tooltip explains). Ends the "is this a bug?" reaction from comparing one session's numbers to
   the larger per-repo total (different scopes: one session vs. all sessions + backfill).
   Served as a `repoTotals` map on `/api/state`, aggregated via a shared `aggregateReposAcrossDates` helper
   (also used by History, so they can't diverge) and MEMOIZED — `buildStatePayload` is on the SSE broadcast
   hot path, so it must not re-scan the log dirs each frame; the cache clears on any token/rollover/prune/
   cost-config change. Figure is all-time but bounded by `retentionDays` (disclosed in the tooltip), not
   tied to the Per-repo view's range filter.
   Known limits: all-time PROMPTS count live turns only — backfill imports tokens/cost but no turn count, so
   it under-represents repos with imported history; and cost uses `estimateCost().total` (like every other
   cost figure), silently omitting unpriced/unknown models — uniform partial-cost disclosure is deferred.

10. Dropped the `idle-waiting` status ("Idle — awaiting input"); a finished turn now stays plain `idle`,
    restoring CONCEPT's four-status model. It flagged Claude Code's `idle_prompt` ("done, awaiting next
    prompt"), which read as needs-attention on a done turn — and also fires mid-turn while a subagent works,
    so it's no reliable "awaiting you" signal. Now only a permission `Notification` → `waiting`; `idle_prompt`
    settles a running session to idle only when nothing's in flight (guards a lost Stop), never as "waiting".

11. Live cards now show "Active" — a session's cumulative working time (Σ closed-turn durations,
    `session.activeMs`, added on Stop/StopFailure), distinct from the wall-clock Age beside it. The muted
    repo-total row gains the repo's all-time active time too, and cards widened to fit the extra column.
    Like prompts, activeMs counts live turns only — backfill can't reconstruct turn boundaries — so it
    under-represents repos with imported history.

12. The model chip is now reliable. `session.model` is backfilled from the transcript on each usage read,
    picking the DOMINANT model by output tokens. Before, model came only from `SessionStart` — the sole hook
    that carries it, and it may omit it — so resumed / post-snapshot-loss sessions showed no model. Dominant-
    by-output (not the most-recent message) avoids mislabeling a session with a transient compaction/sub-model.

13. Fixed a runaway prompt timer in the `idle_prompt` lost-Stop guard (entry 10): it flipped status to idle
    but never cleared `currentPrompt`, so the browser ticked the elapsed timer forever under an Idle badge.
    It now actually closes the turn (clears currentPrompt + records the duration), matching the guard's intent.

14. Active time redefined as ENGAGED wall-clock and made consistent across every view (live card, per-repo,
    History). A session accrues active time while `running` OR with a subagent/workflow in flight, and NOT
    while `waiting` on a permission prompt or idle. So it now EXCLUDES permission/idle waits and INCLUDES
    background-workflow time (a `Workflow`'s `workflow-subagent` hooks arrive on the parent session after the
    launching turn's Stop). Chosen over the old turn-duration because raw turn wall-clock counted lunch-break
    permission waits and missed background work the user is really waiting on.
    Now derived from the EVENT LOG via an incremental engaged clock (`aggregate.applyEvent`'s `engagedSince`),
    not from turn `durationMs` (that field is dropped from new usage records). The live per-session `activeMs`
    and the per-repo/day rollup + by-hour histogram all run the SAME `applyEvent` replay
    (`accumulateActiveFromEvents`), so they can't diverge, and because active time is a pure function of the
    durable, replayed event log it is crash-safe with no separate persistence (a restart re-derives identical
    values — verified). The engaged clock is hardened against a missing/unparseable ts (stops the clock rather
    than later settling the idle gap) and a backward/out-of-order ts (never re-anchors backward).
    Limits: a background `Bash` (`run_in_background`) spawns no subagent so its time can't be seen; backfilled
    history has no events so contributes tokens/cost but no active time; a span still engaged across midnight
    loses the slice between its last pre-midnight and first post-midnight event (the clock is reset at day
    rollover so the live and re-derived figures agree rather than diverge). Known transient boot-window edge:
    the live per-session `activeMs` can briefly disagree with the rollup right after a restart in narrow cases
    (an event appended during the boot read window; a same-day upgrade from a pre-clock v0.4.0 snapshot with no
    `engagedSince`; a boot straddling local midnight) — it self-corrects on the next restart's re-derivation,
    and fully unifying the snapshot-fast-start and event-rescan paths is a deferred follow-up.

15. Live view gained a per-browser sort toggle (`Status | Name`) in its header. `Name` sorts cards purely
    alphabetically by repo (then cwd, then sessionId) for STABLE positions that don't reorder on activity;
    `Status` (default) keeps the server's waiting-first order. Client-only, remembered in `localStorage`
    (`cockpit.liveSort`) — the daemon's `compareCards` is untouched. Waiting is not floated up in `Name` mode;
    acceptable because the working set is small (grid never scrolls) and the ribbon's "Waiting" tile backstops.

16. Live cards show two new per-session stat columns — Agents (`subagents.total`, per-type tooltip) and Tools
    (`session.toolCount`) — and the wall-clock Age column was dropped, so the row is now
    Chats·Tokens·[Cost]·Active·Agents·Tools. Note the display labels: the prompt-count column is labelled
    "Chats" (field is still `promptCount`) and the subagent column "Agents" — a UI wording choice; the "Chats"
    rename also applies to the Per-repo table's prompt column. Card width tuned to `.cards` minmax
    min(420px,100%) so THREE cards fit across the 1400px content column, with a tight stat-grid gap + compact
    mono values so the (now 6) columns fit. The old active-subagent chip was removed (column + tooltip
    subsume it).

17. Tool usage is now counted. Per session: `session.toolCount` increments on every `PreToolUse`
    (num()-guarded for snapshot restore), including subagent tool calls (they fire on the parent session_id).
    Per repo: a new event-derived `byTool` rollup tallies `PreToolUse` by tool name — UNCONDITIONALLY, on its
    own branch, NOT gated on the active clock's `activeDelta>0` (else midnight/idle-start calls would drop and
    live-vs-rescan would diverge) — exposed on `/api/state` repos and `/api/history` topRepos, and shown as a
    sortable "Tools" column (with a per-tool breakdown tooltip) on the Per-repo page. Like active time, byTool
    is event-derived, so backfilled/event-pruned days show Tools 0.

18. The Live card's model chip now shows the session's CURRENT model, reversing entry 12's dominant-by-output.
    `updateSessionTokens` sets `session.model` from the most-recent transcript message with `output>0`,
    EXCLUDING sidechain (subagent) turns and `<synthetic>`/`unknown` pseudo-models (`isDisplayModel` +
    the new `transcript.js` `sidechain` flag) — so a mid-session `/model` switch shows on the next real turn
    without a subagent's cheaper model or a usage-only record mislabeling it. `session.modelsUsed` (real models,
    first-seen) drives a "models this session (current)" tooltip. Display only — per-message token/cost
    attribution is unchanged (only a truly model-less message's fallback bucket tracks the displayed model).

19. Cards PULSE on a status change to make it noticeable, with the two most important transitions emphasized:
    running→idle ("done", a distinct accent-blue pulse — not the muted idle grey) and running→waiting ("needs
    you", amber) pulse LONGER (5 cycles, equal length); every other change is one short pulse in the new
    status's colour. Reuses the existing `prevStatus` transition detection (a single pass shared with the sound
    cues), gated on `soundsPrimed` so the first snapshot / reconnect resync doesn't flash the grid. Keyed by a
    per-session `App.flash` = {until, cls} window (not a one-shot set) so the pulse survives the frequent
    card-grid re-renders; finite CSS iteration counts mean a lingering class never pulses forever. New sessions
    pulse once as a new-card cue; disabled under `prefers-reduced-motion`.

20. The big live-card timer now KEEPS COUNTING while a background workflow runs. Before, it showed "— / prompt"
    once the launching turn's Stop cleared `currentPrompt`, even though the session's subagents were still
    working. `aggregate` now stamps `session.engagedStartedAt` (start of the current continuous engaged period,
    persisting across the Stop while subagents stay in flight, cleared when fully idle); the card ticks from it
    (label "working") when there's no open prompt but a subagent is active. So an open turn still shows its
    prompt timer, and a background workflow shows a continuous "working" timer instead of a frozen dash.

21. Status-change pulse made clearly visible and the repo-total row completed:
    - The pulse now uses a thick ring + a large outer glow + an inner glow (was a faint outer glow only), and
      the running→idle "done" pulse is a BRIGHT sky-blue — the mid accent blue was washing out against the
      dark-blue backdrop.
    - The card's muted repo-total row now also shows Agents and Tools totals (it previously stopped after
      Active). Backed by a new per-repo `subagents` count in the rollup (event-derived from `SubagentStart`,
      same unconditional pattern as `byTool`) plus a `tools` = Σ`byTool`, both summed across days and exposed on
      `repoTotals`; `byTool`/`SubagentStart` now invalidate `repoTotalsCache`. Like chats/active, these are
      live-only (no backfill). Reverses the earlier spec non-goal that the total row carried no Agents/Tools cell.

22. Fixed the default pricing table: `claude-opus-4-8` was at the retired Opus 4.1/4.0 tier ($15/$75) — a 3x
    cost overestimate on the most-used model — now Opus 4.5+ pricing ($5/$25). Added the other shipping models
    (Fable 5, Opus 4.7/4.6/4.5, Sonnet 4.6/4.5) so they price out of the box instead of `—`. Sonnet 5 kept at
    standard $3/$15 (its $2/$10 intro rate lapses 2026-08-31). Defaults only — a saved custom `rates` map still
    overrides these, and there is no live pricing fetch, so a new/unlisted model shows unpriced until added.

23. The running→idle "done" pulse changed from sky-blue to a bright CYAN (rgba(34,211,238)); the mid accent
    blue washed out against the dark blue-tinted backdrop. Its ring/glow treatment from entry 21 is unchanged.

24. One-time config migration: `readConfig` stamps a `configVersion` and, for a config from before the
    entry-22 fix, upgrades any rate still equal to its pre-v1 default to the current one — so the Opus 4.8
    $15/$75 → $5/$25 correction reaches users who persisted a `rates` map (authoritative per entry 5, so it
    otherwise shadows the fix). Match is by value; a changed/removed rate is untouched. Persisted once as the
    minimal RAW config (omitted fields still inherit live defaults, not frozen), version-gated so it never re-runs.

25. Session engagement (active-time clock + the card's big "working" timer) now derives from Claude Code's
    authoritative `background_tasks` count — `emit.js` stores its LENGTH as `bgTasks` (Stop/SubagentStop payload,
    v2.1.145+) — replacing the ±unreliable subagent start/stop counter, whose skew (up to +12 in a real day's
    log) stranded done sessions "engaged": a phantom timer under an Idle badge + the idle gap folded into active.
    `isEngaged = running || bgTasks>0`; a shared client `effectiveStatus` (and the server card sort) read a
    session with background work in flight as "running", so badge/colour/timer/sort all agree. Bonus: a
    `run_in_background` Bash (registry type "shell") now counts as active (closes an entry-14 gap); graceful on
    Claude Code <2.1.145 (no `background_tasks` → running-only, no phantom). Stores the COUNT only — a task's
    command/name/description is free text (paths, prompts) and would breach the no-message-content boundary.

26. The "session finished" OS notification and the "done" card pulse/sound now fire on the real engaged→idle
    transition (aggregate's `disengagedNow`) GATED on the settled status being `idle` — not merely on Stop. So a
    handoff Stop with background work in flight stays silent, a permission prompt (running→waiting) fires only
    needsInput, and "finished" lands at real completion. Since a background workflow's last subagent leaves status
    `running`, the event that empties `background_tasks` first settles that residual `running`→idle (when no
    foreground turn is open) so completion actually registers. Client pulse/sound key off the same
    `effectiveStatus`, so visual, sound and OS notification agree.
    Known limit: a DROPPED SubagentStop leaves the session "engaged" (a lingering "working" timer, no finished
    ping) until the next turn's Stop re-reports the count — bounded and self-healing, unlike the old counter's
    permanent drift.

27. Automatic retention pruning is gone: the `retentionDays` config field and the `pruneOld` timer are removed.
    Chosen because the user wants the store cleaned only on demand, never behind their back. History now grows
    unbounded until a manual cleanup. A persisted `retentionDays` goes inert (dropped as an unknown key by
    `validateConfig`; no migration). Behavior flip worth noting: anyone who had set `retentionDays` to bound
    disk now keeps everything until they clean up.

28. Manual data management added. `GET /api/storage` reports the store's on-disk size (events+usage+rollups
    +snapshot, excluding daemon.log) and day span, computed per-request and never on the SSE hot path.
    `POST /api/data/cleanup {olderThanDays:N}` deletes whole day-files older than today−N (never today's) — the
    safe subset of the old auto-prune: whole-file unlinks, no concurrent writers. Surfaced in a new Settings
    "Data" section: store size + an N-days cleanup whose confirm previews the scope before committing.

29. Delete-a-repo. `POST /api/repos/delete {repoRoot}` hard-deletes one repo's accounting across every
    usage/event/rollup day-file, unlinking emptied files so the store actually shrinks. Refuses with `409` if a
    live session owns the repo (its in-flight events would otherwise re-populate it). The current-day event log
    is rewritten too, and its tail byte-offset reset to the shrunk size, so the next tail can't re-read and
    double-count the OTHER repos' live state (the sharp edge — a naive shrink would trip the size<offset
    "truncated→restart-from-0" path). Triggered from a ⋯ menu on the Per-repo page behind an in-app confirm.

30. The Live card's big timer no longer counts up while `waiting`; it FREEZES (label "paused") at how long
    the prompt ran before it blocked — anchored to a new STABLE `session.waitingSince` (aggregate sets it
    once on entering waiting, clears it on leaving), so a benign mid-wait event that refreshes lastActivityAt
    can't creep it. Ticks only while running/engaged; on approval "elapsed" resumes from true prompt
    wall-clock (the Active stat, not this timer, is the wait-excluding metric). Cause: a permission
    Notification sets `waiting` without clearing currentPrompt, so the prompt timer kept ticking on a blocked card.

31. Restored the live in-flight pill on the Live card (dropped in entry 16 for the cumulative Agents stat):
    green with a pulsing dot, next to the model/effort chips, shown ONLY on a running card while bgTasks>0
    (suppressed on waiting/error, where a green pulse would misread as progress). Sourced from Claude Code's
    authoritative background_tasks count (bgTasks), NOT subagents.active (dropped-SubagentStop drift
    over-reports). Labelled "N in flight" — bgTasks also counts run_in_background shells, so "subagents"
    would misname them (the tooltip gives the full scope). Reuses the shared `pulse` keyframe.

32. Per-repo view now defaults to the All range (was Today), and its non-today ranges no longer show "—" for
    Chats, Sessions, and Last active. The `/api/history` topRepos now carries `prompts`/`sessions`/`lastActive`
    (previously dropped, so `loadRepos` hard-coded them null). Sessions are now derived for EVERY day the same
    way — from the event log — by folding the session set into `addActiveFromEvents` (so past days match today,
    and `rebuildTodayRollup`'s duplicate session loop is gone); `aggregateReposAcrossDates` unions distinct
    session ids across days and takes the max lastActive. Consistent with the documented backfill limit: a
    backfill-only day (tokens/cost, no events) still contributes 0 sessions / 0 chats / 0 active, so those
    columns stay in step rather than diverging.
    Two consequences of making All the default (found in review): `/api/history` topRepos is no longer
    capped at 10 — the Per-repo table shows every repo in the range, and the History "Top repos" chart caps to
    its top 10 client-side instead. And the table now live-refreshes on ALL ranges (was Today-only): SSE frames
    trigger a throttled re-fetch (≤1/`REPO_REFRESH_MS`) for historical ranges so a default All view doesn't
    freeze during active work.

33. Per-repo table gained an Agents column (subagents spawned, `SubagentStart`-derived), between Tokens and
    Tools — mirroring the Live card's Agents·Tools pairing. Exposed as `subagents` on both the today
    (`reposSummary`) and historical (`/api/history` topRepos) paths; already aggregated per repo in the rollup,
    just not surfaced. Event-derived like Chats/Sessions/Tools, so backfill-only days show 0.

34. Live view decluttered + two new ribbon tiles. Removed the topbar brand (icon + "Cockpit / mission
    control") and the Live header (title + "N active" note) — pure chrome; nav tabs + connection dot remain.
    The Live ribbon gains "Active agents" (Σ session.bgTasks — background tasks/workflow agents in flight now,
    from the authoritative count, NOT drift-prone subagents.active) and "Active time" (Σ session.activeMs of
    the live sessions — rolls up each card's Active stat).
    The Status/Name sort moved from the Live header to Settings > Dashboard ("Live view sort") — still a
    per-browser localStorage pref (not daemon config), intercepted before the config-save handler so it
    never PUTs or pops a "Settings saved" toast.

35. New top-level Sessions view (v0.10.0) + `GET /api/sessions` listing EVERY retained Claude Code session by
    reading the transcript filesystem directly (`~/.claude/projects/<encoded-cwd>/*.jsonl`), not the cockpit's
    store — newest-first by file mtime, paginated (`pageSize` default 50, clamped `[1,100]`; `page` coerced,
    out-of-range → empty page + correct total). Every transcript is exactly one row (no file dropped), so
    `total` equals the rendered count and paging is exact. Names come from the transcript `ai-title`; the
    verbatim `last-prompt` is NEVER surfaced — that line is the privacy boundary (derived label yes, raw text
    no). Cost bounded by a ~3s stat/sort snapshot (sweep) + a per-file mtime/size parse cache (parse), so the
    O(total) scan never runs on the SSE hot path.
    Deliberate consequence: this view follows CLAUDE CODE's transcript retention, not the cockpit's — so a repo
    removed via `/api/repos/delete` (or days via `/api/data/cleanup`) still lists its sessions here. The price
    of complete coverage with no new store/writer; "active" is a client overlay intersecting the live stream.
    The endpoint reads each page's transcripts ASYNCHRONOUSLY (never a blocking readFileSync on the event loop),
    so a cold page can't stall SSE/hooks/notifications for other sessions. An unreadable/unparseable transcript
    shows tokens as UNAVAILABLE ("—"), never a misleading 0/$0.000 (the graceful-degradation rule).

36. Sessions view gains an **Active** (engaged time) column, and **Last active** moved to the far right.
    Active time can't come from transcripts (it's event-log-derived), so a new `aggregate.accumulateSessionActiveFromEvents`
    replays the event log PER SESSION with the SAME engaged clock as Live/Per-repo — so a repo's active time equals the
    sum of its sessions' by construction. A live session uses its live `activeMs`; a past session the cockpit observed
    uses a cached event-log index (per-past-day memoized, summed under the snapshot TTL, invalidated on rollover/cleanup/
    repo-delete); a session the cockpit never saw (pre-install / transcript-only, no events) shows "—", not a false "0s".
    The index build is ASYNC (reads each day's log with an await between days), so even a cold build after boot/cache-clear
    never freezes the event loop replaying all history at once. A session the cockpit DID observe but that did no engaged
    work is recorded as 0 (shows "0s"), kept distinct from a never-observed session ("—"). A live row's Active uses the
    fresh live `activeMs` and is updated in place each SSE frame (no table rebuild, so text selection survives).

37. Renamed the "Per-repo" dashboard tab (and its "Per-repository" view title) to "Repos" — shorter label,
    same view. Label-only: the `data-view="repos"` id, the `repos` route, and the API/rollup fields are
    unchanged; "per-repo" as a concept (per-repository accounting) stays in prose and code comments.

38. The Live ribbon is now a "today at a glance" summary (Live is the main screen). Sessions, Agents, and
    Active time are TODAY's totals summed from the today per-repo rollup (`App.state.repos`), not sums over
    only the live sessions — so a session that already ended today still counts. Only Running / Waiting stay
    momentary (status counts over the live set). "Active agents"→"Agents" (now Σ today's `subagents`, not the
    in-flight `bgTasks`), and the "today" postfix dropped from Tokens/Cost since the whole ribbon is now today.
    Sessions/Agents sum per-repo counts, so a session spanning two repos counts once per repo (rare; matches
    the Repos table). The ribbon reads `r.sessions` as array-or-number (mirroring `normalizeRepoRow`) so it and
    the Repos table can't disagree on a stale payload. Known edge: a session live but idle since before midnight
    logs no event today, so it's absent from today's rollup — its card still shows but it isn't in the Sessions
    count (the inverse of an ended-today session, which does count).

39. Settled a recurring ask: the live "in flight" pill CANNOT reliably count subagents specifically. A
    foreground Task/Agent subagent (e.g. an `Explore` review) fires SubagentStart/Stop but never enters Claude
    Code's `background_tasks` registry (verified via a temporary emit.js capture: bg_tasks=0 throughout its
    run), and the start/stop counter drifts on dropped Stops. The registry holds only BACKGROUNDED work —
    Workflows (`type:"workflow"`) + run_in_background shells — which is exactly what bgTasks / the pill already
    show. Registry elements DO carry a `type`/`status` discriminator, so a future per-type breakdown
    ("1 workflow") is possible — but it still can't see Task subagents. Don't re-attempt from these signals.

40. The Live "No active sessions" empty state now spans the full content column (centered) and sits lower,
    below the ribbon. Scoped as `#cards .empty { grid-column: 1 / -1 }` because `.cards` is a grid — without it
    the box landed in the first ~420px cell (top-left), so its `text-align: center` only centered text inside a
    left-anchored box. Scoped to `#cards` so the Repos/Sessions/loading empty states are untouched.

41. Documented (not yet fixed) a CONFIRMED accounting bug: a `--fork-session --resume <parent>.jsonl` fork
    (Claude Code backgrounding a session) copies the parent's transcript keeping the same message-uuids, but
    token dedup is keyed per session_id, so the fork re-counts every inherited message — inflating the shared
    repo's tokens/cost. Verified live (parent + fork shared 41 uuids, same repo_root).
    Fix is specced at `docs/specs/2026-07-06-forked-session-accounting.md`: dedup on the globally-unique
    message-uuid (positional `__idx_*` fallback ids namespaced per-session so they don't false-collide), plus a
    symmetric `sharesHistory` badge on the Live card (forks share the parent's name, so twins looked identical).
    Active time is intentionally NOT changed — concurrent sessions on one repo correctly sum active time.

42. Live page now shows account-wide rate-limit usage — a Session (5h) + Week bar on the ribbon, fed by an
    OPT-IN statusline forwarder that POSTs only `rate_limits` to a new `POST /internal/usage` (behind the
    existing bearer/origin gate). ONE global snapshot (rate limits are account-wide, so every session reports
    the same numbers), served on `/api/state` `usage` and persisted in the snapshot. Source is the Claude Code
    statusline payload — the only LOCAL carrier of this data (hooks/transcripts don't have it and we never call
    the API). The 5h bar carries a pace cue (a tick at elapsed-% + a signed burn-rate delta), settable via a new
    `usagePace` config (`both`|`tick`|`delta`|`off`); it is FROZEN once a bar goes stale so a moving delta can't
    animate an ever-more-wrong "under pace" against known-stale data. Honest degradation (the "no wrong zero"
    rule): no snapshot → an "install the statusline" affordance, never a fake 0; a passed reset → "reset •
    awaiting update"; a >10-min-old snapshot → dimmed "updated Xm ago". Only `five_hour`+`seven_day` aggregate
    exist (NO per-model bar), and only for Pro/Max after the first API response. The daemon broadcasts only when
    the numbers actually CHANGE (the forwarder posts on every render — an unchanged push must not rebuild the
    Live grid). Normalization (resets_at seconds→ms, used_percentage clamp 0–100, malformed-body drop, per-window
    independent) is the pure, unit-tested `scripts/usage.js`; the module-level snapshot var is `rateLimitUsage`
    (named distinctly from the file's many local `usage` vars so a dropped `let` can't clobber it).

43. Statusline tooling shipped under `statusline/` (colored-line renderer + README + install.sh) — installing it
    is what feeds entry 42's usage bars. Install is an ABSOLUTE path written into `~/.claude/settings.json`
    `statusLine.command`: verified `statusLine.command` supports NEITHER `${CLAUDE_PLUGIN_ROOT}` NOR a
    plugin-shipped top-level `statusLine` (a plugin can only ship `subagentStatusLine`), so it must be re-run
    after a plugin upgrade (the install dir is hashed and GC'd ~7 days later). Cross-platform via `node <path>`
    (no bash wrapper); `install.sh` is a Unix-only convenience (timestamped backup, idempotent skip-if-ours) and
    the manual README edit is the all-OS path. The renderer reads the branch from `.git/HEAD` via `repo.js` (no
    per-render `git` subprocess) and fires the best-effort POST only AFTER stdout flushes (a synchronous exit
    could truncate a piped status line).

44. The weekly (7d) usage bar now carries the SAME pace cue (tick + delta) as the 5h bar, governed by the
    existing `usagePace` setting — one control now applies to BOTH bars (Settings label generalized from
    "5h usage pace cue" to "Usage pace cue"). Reverses entry 42's "5h only" scope. Cheap because the cue
    machinery was already per-window (elapsedFrac over each bar's windowMs); the weekly bar simply stopped
    being hard-passed "off". A 7-day pace line moves slowly (rarely the thing you react to), kept for consistency.

45. Trimmed the Live view's vertical rhythm so a 2nd row of session cards fits above the fold on laptop
    screens — reclaims ~75px through the ribbon + first two card rows. Proportional cuts: sticky topbar
    padding 12→9, main top-pad 22→16, ribbon margin 20→14, tile pad 14→11, the usage bars' padding/margins
    tightened, card body pad 15→12 + inter-section gap 10→8, card-grid gap 16→12. The big prompt timer (the
    card's focal point) is deliberately left full-size — space came from chrome and gaps, not the content.
    Pure CSS.

46. A stale usage bar (>10 min since the last statusline push) is no longer DIMMED — instead it keeps its
    fill + a live-drifting pace cue and shows a now-legible "updated Xm ago" note (bumped ink-muted→ink-2) as
    the sole "old data" signal. The pace tick/delta keep advancing on a stale bar: usedPct is frozen but
    elapsed grows, so the over-pace amber delta walks down toward/under 0 over time until reset — which is the
    intended pace reading, not a bug. This DELIBERATELY reverses entry 42/44's freeze-on-stale (the earlier
    code-review "don't drift a wrong under-pace" fix): per the user, the drift IS the desired behavior and the
    age note flags the staleness, so do NOT re-freeze it. `reset`/`nodata` bars stay dimmed (no live fill).

47. Reordered the statusline to `cwd · ctx · usage(5h) · tokens · cost · branch · model` (was
    `model · repo · branch · tokens · cost · active · ctx · 5h`); the active-time segment was dropped
    (with its now-unused `dur()` helper). The cwd segment now shows the directory
    where Claude was STARTED — sourced from `workspace.project_dir` (the original project dir), falling back
    to `current_dir` then `cwd`, basename only (the three coincide unless a session starts in a subdir/worktree).
    Edits the in-repo `statusline/statusline-render.js` — the file the installed `statusLine.command` points at.
    Colours unchanged; also merged a duplicate `context_window` read and tightened the segment divider
    from `  ·  ` to ` · ` to fit more values on the line.

48. The Live ribbon tiles are now a pure today's-totals summary: `Tokens | Cost | Sessions | Chats | Tools |
    Agents | Active time`. Added Chats (Σ today's `prompts`) and Tools (Σ today's `byTool`), both summed from
    the today per-repo rollup like the existing tiles. The momentary Running / Waiting status tiles were
    DROPPED per user request (reverses entry 38's keep — status is still on each card's badge), so the ribbon
    no longer reads the live-session list at all; `renderLiveRibbon` dropped its `sessions` param.
    Consequence (accepted): this removes the ribbon's `tile--alert` Waiting signal that entry 15 named as the
    backstop for "Name" sort mode (where waiting cards aren't floated up) — in that non-default mode a blocked
    session below the fold now has no global surfacing cue but its own amber card. Don't re-add the tile to "fix"
    this without asking; the drop was the explicit request.

49. Live card per-session stat columns reordered to `Tokens | Cost | Chats | Tools | Agents | Active` (was
    `Chats | Tokens | Cost | Active | Agents | Tools`) — leads with the money/token figures. The aligned
    muted repo-total row below mirrors the same order (the two rows share the stat grid's columns and must
    compare straight down); Cost still drops out when disabled, shifting both rows left one column in step.

50. One canonical stat-column order now governs every accounting surface (v0.14.0; documented in
    ARCHITECTURE.md's Dashboard section): `Tokens · Cost · Sessions · Chats · Tools · Agents · Active · Last active`. Each
    surface renders the applicable subset in this relative order and omits the rest — never re-orders. Rules:
    Sessions is omitted on single-session surfaces (Live card, Sessions row); Cost drops when cost display is
    off; the live surfaces (ribbon, cards) drop Last active (status/timer convey currency).
    - Repos table reordered to `Repository | Tokens | Cost | Sessions | Chats | Tools | Agents | Active |
      Last active` (was Active-led, near-reverse). Display-only: sort still resolves by column key, default
      stays Active-desc.
    - Sessions table reordered to `Name | Repo | Tokens | Cost | Chats | Tools | Agents | Active | Last active`
      and GAINED Chats/Tools/Agents. These are EVENT-derived (same source as the Live card/Repos), NOT counted
      from the transcript — a transcript's raw prompt/tool counts diverge from the cockpit's event counts (e.g.
      7 vs 1 chats, 34 vs 23 tools for one live session) and would contradict every other page. A new
      `aggregate.accumulateSessionStatsFromEvents` returns `{activeMs,chats,tools,agents}` per session off the
      SAME replay as active time (it REPLACES the old `accumulateSessionActiveFromEvents`, now removed — every
      caller reads the richer record); the daemon's per-session index now carries all four. A live session
      shows its live counters; a past observed session the event-log index; a never-observed session
      (pre-install / event-pruned) shows "—" for all four, an observed-but-idle one shows 0 (kept distinct —
      no misleading zero). Sessions-count stays omitted from a session row (meaningless for one session, like
      the card).
    - All four EVENT-derived live cells (Active, Chats, Tools, Agents) refresh in place each SSE frame via
      `refreshLiveStatCells` (renamed from `refreshLiveActiveCells`, which touched only Active). Without it
      Tools/Agents froze at turn-start on a live row — the rebuild signature keys off status/timer-anchor,
      which tool/subagent counts don't move — so the row disagreed with its Live card mid-turn. Tokens/cost
      are deliberately NOT refreshed (transcript-sourced snapshots, only change on refetch).

51. The Live usage bars now show the ABSOLUTE reset moment next to the countdown, not just "resets in …" (v0.15.0):
    the 5h bar appends the local clock time ("resets in 4h 02m · 10:30"), the weekly bar appends weekday +
    day + month + time ("resets in 5d 4h · Sun 12 Jul, 11:00") — the multi-day window needs the date to be
    unambiguous. The 5h bar's bare time gains a weekday prefix ("· Thu 03:00") ONLY when the reset lands on
    another local day than now — an evening-started rolling 5h window resets after midnight, so a plain
    "03:00" would misread as earlier today. One shared `fmtResetLine` (countdown + `fmtResetAt`, keyed by a
    `withDate` flag) builds the line for BOTH the render path and the per-second tick path, so they can't
    drift; the absolute time is fixed while only the countdown advances. `.usage-bar__foot` gained
    `flex-wrap` so the now-longer line wraps the pace-delta chip below it on a narrow bar instead of
    overflowing; the chip uses `margin-left:auto` (not `justify-content:space-between`) so it stays
    right-aligned whether it shares the line or wraps.

52. The Live usage bars' pace delta now shows BOTH the percentage AND time — "▲ 5% · 21m ahead" /
    "▼ 22% · 1d 13h behind" / "on pace" (was percentage only, "▲ +8%") (v0.16.0). The % is the gap in
    percentage points (usedPct − elapsedFrac×100), the time is that SAME gap × window length — legible units
    esp. on the weekly bar where a bare % gap was hard to feel (a +22% reads as "1d 13h ahead"). Both are the
    fill-vs-tick gap the tick already shows, so no new information — just readable. Minute resolution (no
    seconds); a gap within a RELATIVE on-pace band (~0.5% of the window, floored at 60s) reads "on pace" —
    relative so the 7d bar keeps a ~50min band, not a fixed 60s it would never hit. `usagePace`/tick/
    fill-colour/reset-line all unchanged. Chose this linear rescale over a burn-rate exhaustion projection
    ("you'll run out X early"), which is more actionable but jumpy early in a window — deferred, not rejected.

53. Both Live usage bars now carry a "time left at current velocity" ETA after the pace delta (v0.17.0) —
    the burn-rate exhaustion projection deferred in #52, now shipped. Simple linear velocity:
    timeLeft = ((1 − usedFrac) / usedFrac) × elapsed. Over pace → "≈3h left" (amber) with the shortfall in
    the tooltip; under pace → "won't run out" (muted, no huge number in text OR tooltip); on pace → the
    reset-sized "≈X left" muted (not a warning). The over/under/on verdict is decided by the SAME signed gap +
    `paceTolerance` band the delta uses — NOT a bare timeLeft<timeToReset boundary, which would fire amber
    while the delta beside it still read "on pace" (the two cues on one bar must agree). Sub-60s renders
    "<1m left" (fmtPaceGap floors to minutes, so it would otherwise read "≈0m left"). Gated to a settled
    reading — blank under ~1% used or in the window's first 1% elapsed, where the projection swings wildly
    (the #52 "jumpy early" caveat). On a STALE bar it keeps drifting in lockstep with the delta (per the
    entry-46 no-re-freeze rule; the age note flags staleness). Rides alongside the delta, gated on the same
    `usagePace` (shown for `both`/`delta`); advances every second on the shared tick loop via `applyEta`, the
    render+tick single implementation mirroring `applyDelta`.

54. Both Live usage bars REPLACED the time-left ETA (entry 53's "≈2h left") with a burn-rate MULTIPLIER
    riding after the pace delta in the foot ("▲ 5% · 12m ahead   2.5×") (v0.18.0) — current velocity as a
    multiple of the even "normal" rate that lands on exactly 100% at reset, so 1.0× is on pace, 2.5× is 2.5×
    that. `m = usedFrac / elapsedFrac`, via a new `applyMult` (render+tick single impl, mirroring applyDelta).
    Chosen over the ETA countdown because a rate reads as inherently variable — an early swing looks like
    "going fast now", not the ETA's alarming, jumpy-early "you'll run out in 2d" against a small lead early in
    a 7d window (the contradiction that prompted the swap). `applyEta` and its `.usage-bar__eta` styles are
    removed.
    Coloured by the SAME rounded value it DISPLAYS (over→amber, under→green, on→muted), so the number and its
    colour can never contradict — a shown "1.0×" is always the muted on-pace colour, "1.1×"+ over, "0.9×"−
    under. This is a RATIO verdict, deliberately NOT the delta's additive time-gap verdict: near a window's
    START a small absolute gap is a large ratio, so the multiplier can read over/under while the delta still
    reads on-pace — the ratio is the intended earlier signal there. (Colouring by the gap would paint a
    rounded "1.0×" amber mid-window and a far-from-1× ratio muted early — the number fighting its own colour.)
    Blank in a jumpy-early guard (window's first 1% / under 1% used); at the cap (pct≥100) it shows "at limit"
    (error colour) — with the ETA gone the multiplier is now the sole exhausted-state cue. On a stale bar it
    drifts down (entry-46 no-re-freeze). Gated on `usagePace` (shown for `both`/`delta`), travelling with the
    delta. The head is unchanged (label + %); the multiplier lives entirely in the foot.

55. The pace delta dropped its trailing "ahead"/"behind" word — the ▲/▼ arrow + amber/green colour already
    convey direction (user's call, "the colour says it all"). It now reads "▲ 6% · 18m", and a muted "·"
    joins it to the burn-rate multiplier so the two read as one line: "▲ 6% · 18m · 1.3×". The word survives
    only in the hover title ("6% ahead of an even burn rate") to disambiguate the colour. The joining "·" is
    a `.usage-bar__mult::before` (muted, like the reset line's separators), so it vanishes with the
    multiplier under `:empty` (jumpy-early guard) — no dangling dot.

56. Root CLAUDE.md gained a "Multi-agent workflows" section: when fanning work across subagents (the
    Workflow tool), tier each agent's model/effort — strong for contracts/review, mid for verify/apply,
    cheap for docs/changelog. And INVOKING a named workflow (e.g. code-review) still bills every stage at
    the session model unless its scriptPath is edited to tier the checking stages down. Inert unless a
    multi-agent workflow actually runs.

57. History view expanded from 4 charts to 15 in four families — Time-series, Distributions, Rhythm,
    Efficiency ratios — plus an interactive PIVOT (one stacked chart re-decomposed live by Measure ×
    Group-by × Normalize). Spec: docs/specs/2026-07-08-history-charts-expansion.md (v0.19.0).
    One enriched `/api/history?range=` payload feeds all of it: each `perDay` now carries per-group
    breakdowns (`byModel` {tokens,cost}, `byRepo`, `byTool`, `byAgentType`, `costByType`) + scalars
    (prompts/sessions/tools/subagents), and a top-level `byDowHour` 7×24 matrix REPLACES `byHour`. The
    pivot re-slices this in the browser — only a range change refetches. History stays off the SSE path.
    New rollup field `byAgentType` (event-derived from `SubagentStart.agent_type`, same unconditional
    pattern as `byTool`/`subagents`) — added on BOTH the live handleEvent branch and the boot rescan, else
    today's per-type breakdown lags until restart. Per-day per-model AND per-token-type cost are priced
    server-side; the day's combined map is priced ONCE and reused (dropped the redundant `dayCost`).
    `byDowHour`/calendar weekday is computed LOCAL (new Date(y,m-1,d)), never `new Date(str)` (UTC-shifts).
    The pivot is HONESTY-CONSTRAINED (measure-led): only attributable Measure×Group cells are selectable —
    active/chats aren't attributable to a model/tool, tokens/cost aren't attributable to a tool/agent — so
    an unbacked cell is absent, never a wrong zero; a group invalid under the current measure falls back to
    Repo. Overflow past 6 series folds into a muted "Other" slice.
    `charts.js` gained `stacked` (opt `normalize`=100% share), `grouped`, `donut`, `punch` (day×hour,
    generalizes+replaces `hourHeatmap`), `calendar` (caller must Monday-align the days); `styles.css` gained
    the validated categorical tokens `--series-3..6`. Distributions/ratios are pure client-side sums/ratios
    of `perDay` (cache efficiency, burn rate, tokens/chat — divide-by-zero guarded); cost-dependent charts
    show an empty state when cost display is off.
    Known limit: live in-browser render/interaction was NOT verified this session (Chrome extension
    disconnected); verified via 147 unit tests, a sandboxed daemon `/api/history` end-to-end check, and a
    DOM-shim run of every chart primitive.

58. New "Tokens & cost per day" chart at the top of the History view (above the families): a FULL-WIDTH card
    with the title inside it (above the graph), no subtitle, the chart filling the card width and 50% taller
    than a normal card (height 360 vs the 240 default) (v0.20.0). Two lines,
    DUAL-AXIS: tokens on the left axis, cost on the right, each scaled to its
    OWN range so both fill the plot and sit close; axis tick labels are colour-matched to their line and the
    tooltip shows both real values. Dual-axis is a deliberate, user-chosen tradeoff over the honest one-axis
    default (indexed %) dataviz prefers — the two scales are independent, so the crossing point carries no
    meaning (noted at the call site + in charts.js).
    `lineChart` now renders TWO series as this dual-axis chart (per-series scale/fmt/colour, left+right axes,
    legend, one crosshair dot per series); ONE series is unchanged (single axis, area wash, no legend).
    The History card grid became an explicit 12-column layout (normal card spans 4 = 1/3, `half` 6 = 1/2,
    `wide` the full row; collapses 2-up ≤1100px then 1-up ≤680px), replacing the auto-fill minmax(340px) grid
    so a card can be sized to a fraction of the row.

59. Dashboard static assets (index.html / app.js / charts.js / styles.css) are now served with
    `Cache-Control: no-cache` (v0.20.0). serveStatic previously sent NO cache directive, so browsers
    heuristically cached styles.css / app.js across daemon upgrades — a UI edit could render with the new JS
    but STALE CSS (e.g. a chart not filling its card) until a manual hard reload. no-cache makes an ordinary
    reload always fetch fresh; the daemon is local and the assets are tiny, so freshness beats caching.

60. Fixed History charts rendering shrunken and not filling their card (v0.20.0). `#histBody .card` reused
    the global `.card` name (the Live-session card, which is display:flex), so History cards became flex
    ROWS — title in a left column, chart at only its intrinsic width, the card half-empty. Root cause: a
    class-name collision the `#histBody` scoping didn't neutralize because it never overrode `display`; now
    `#histBody .card` sets `display: block`.
    `lineChart` now also renders at its container's REAL pixel width (`vw(host)`) instead of a fixed 640
    viewBox CSS-scaled to fit — so the full-width "Tokens & cost per day" hero fills the width crisply at its
    360px height rather than aspect-scaling into a ~750px-tall giant. The fixed-geometry charts (bars/
    stacked/donut/punch/calendar) keep the 640 grid + CSS scaling.

61. History view pared to a FLAT, full-width list of 8 charts — no grouping, headers, or pivot (v0.20.0):
    Tokens & cost per day · per active hour · Tokens per chat · Cost per day by type · Day-of-week × hour ·
    Calendar heatmap · Subagents by type · Tool usage.
    The three "Tokens & …" line charts are DUAL-AXIS (tokens left, cost right, each self-scaled) with quiet
    DOTTED, axis-less correlation lines — Chats + Avg context on the per-day/per-hour ones, Tools + Active on
    per-chat — read for shape, real values in the tooltip. `lineChart` gained per-series `noAxis` (a
    self-scaled line with no tick axis) and `dash`/`dot` styling; `avgContext` = (input+cacheRead+cacheWrite)
    /chats (prompt-side tokens per turn, an estimate).
    Cost-by-type REPLACED tokens-by-type: token counts are ~all cache-read (a flat one-band chart), but COST
    splits meaningfully because output is ~50× cache-read per token — so the cost split is where the signal
    is for single-model, cache-heavy usage.
    REMOVED as low-signal for that usage: the Measure×Group pivot, the family grouping, and the small
    distribution/efficiency charts (cost/day, cost-by-model, active-by-repo, cumulative cost, chats&sessions,
    model share, cache efficiency, cost/active-hour) — model/token breakdowns are trivial with one model and
    cache-efficiency sits at ~100%. The daemon still emits every breakdown, so they're re-addable.
    `barChart` now auto-sizes its label gutter to the longest category name (capped) and takes an optional
    per-bar `%`-of-total; `barChart`/`stacked` (like `lineChart`) render at the card's real pixel width.

62. Post-review fixes to the History rewrite (v0.20.0):
    - Calendar heatmap now builds a CONTIGUOUS daily series (the first day's Monday → the last day,
      missing days = 0) before layout. It placed cells by array index assuming perDay was contiguous, but
      the "all" range omits inactive days — so the first gap shifted every later day into the wrong
      weekday/week. Confirmed user-facing correctness bug.
    - `lineChart` x-axis labels now iterate the LONGEST series' points (not `series[0]`), so labels can't
      compress/mislabel if a caller ever passes a shorter first series (latent; not hit by current callers).
    - `barChart` reads `opts.fmt || opts.format` (was format-only), unifying the formatter key with the
      other primitives so a direct `{fmt}` caller isn't silently defaulted to `commas`.
    - Removed dead code: the unused `grouped`/`donut` primitives (no caller after the flat rewrite) and a
      stale index.html comment referencing the removed families/pivot.
    Skipped (deliberate, not a bug): buildHistory still emits unread per-day `byModel`/`byRepo` — entry 61
    keeps every breakdown re-addable, and it's off the SSE hot path.
