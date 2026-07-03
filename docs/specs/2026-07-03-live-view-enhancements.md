# Live view enhancements (+ per-repo tool breakdown)

Four additions across the Live and Per-repo views: (1) a per-browser **sort
toggle** (`Status` vs `Name`) so cards can hold stable alphabetical positions;
(2) **Subagents** and **Tools** columns on the live card stat row, showing how many
subagents and tool calls a session has made; (3) a **per-tool breakdown** on the
Per-repo page (Bash ×N, Edit ×N, …), backed by a new event-derived `byTool` rollup;
(4) the card's **model** chip reflecting a mid-session `/model` switch by showing the
*current* model plus a tooltip of every model the session has used. Token, cost, and
active-time accounting are untouched; the only new server state is a per-session tool
counter and a per-repo `byTool` map (both derived from events already logged).

## Key decisions

- **Sort is a client-side toggle, not a server/config change** (new). A
  `.range`-style group (`Status` | `Name`) in the Live `view__head`, held in
  `App.liveSort` and persisted to `localStorage` (the SPA's first use of it — right
  for a per-browser view preference). The daemon keeps sorting waiting-first
  (`aggregate.compareCards`); the client re-sorts only in `Name` mode.
- **`Name` mode is pure alphabetical, ignoring status** (new). Sort by `repoName`
  (`localeCompare`), tie-broken by `cwd` then `sessionId`. Waiting sessions are **not**
  floated up — their highlight still draws the eye but positions stay stable (the
  point of alpha sort). `Status` mode is unchanged and remains the default.
  **Trade-off, judged negligible in practice:** in `Name` mode a `waiting` card is not
  pulled to the top, which in a long list could bury CONCEPT's "surface waiting first"
  triage cue. But the expected working set is small (~6 concurrent sessions at most),
  so the card grid never scrolls and every card — waiting ones highlighted — stays on
  screen; the `liveRibbon` "Waiting: N" tile is a further always-visible backstop, and
  `Status` remains the default. So pure-alpha stands, no waiting-float in `Name` mode.
- **Subagents and Tools are two new stat columns** (extends). The card stat row goes
  from 5→7 columns with cost enabled (4→6 when cost is off — the grid is driven by
  `stats.length`): `Prompts · Tokens · [Cost] · Active · Subagents · Tools · Age`.
  Subagents shows `subagents.total`; Tools shows `session.toolCount`. Both carry a
  tooltip (subagent `byType`; nothing extra for Tools on the card — the breakdown
  lives on the Per-repo page). To fit the extra columns the **cards are widened** —
  bump `.cards` `minmax()` (currently 380px) rather than shrink the stat font, so the
  numbers stay readable; the exact width is settled in the browser-verified pass.
- **The active-subagent chip is removed** (diverges). The Subagents column subsumes
  the `active > 0` chip in `cardHTML`; the active count moves into that column's
  tooltip. Live "running now" stays on the card's activity line.
- **Total tool count is a per-session state counter** (new). `session.toolCount`,
  incremented on `PreToolUse` in `aggregate.applyEvent` — exactly like `promptCount`.
  It counts **all** tool invocations including those inside subagents. **Confirmed**
  against the Claude Code hooks reference: a subagent's `PreToolUse`/`PostToolUse`
  fire on the parent `session_id`, with `agent_id`/`agent_type` present only when the
  hook fires inside a subagent — so a `session_id`-keyed count naturally includes
  subagent tools. (Splitting main-loop vs. subagent tools later is possible by keying
  off `agent_id`, which `emit.js` does not capture today — out of scope here.)
- **Per-repo per-tool counts are an event-derived rollup field** (new). `rollup`
  repos gain `byTool: { toolName: count }`, tallied from `PreToolUse` in the SAME
  per-day event replay that already derives active time (one event-log read, not a
  second). Exposed on `/api/state` repos and `/api/history` topRepos; summed across
  days by `aggregateReposAcrossDates`.
- **The repo-total row on the card gets no Subagents/Tools cell** (reuses). It stops
  after `Active` today; the new columns stay blank there, like `Age`. Per-repo tool
  totals live on the Per-repo page, not the card's muted repo-total row.
- **Displayed model becomes the *current* model, not the dominant one** (diverges).
  `updateSessionTokens` sets `session.model` to the model of the most-recent transcript
  message **with `output_tokens > 0`** (reversing changelog #12's dominant-by-output —
  **for display only**). The `output > 0` filter skips usage-only/cache-only records so
  the chip stays stable across the ~5s `pollTokens` re-reads and only changes on a real
  generated turn; it reflects a `/model` switch on the next such turn. A compaction/
  summary message that itself generates output could still wobble the chip for one
  turn, which the used-set tooltip makes legible. Cheap to revert (in-memory, no
  migration).
- **Token/cost attribution is untouched** (reuses). Cost is still priced per message
  via `byModel`; only the single displayed model string changes.
- **`/model` changes are transcript-derived, best-effort** (reuses). No hook fires on
  `/model` (confirmed against the hooks docs), so the transcript's per-message
  `model` is the only signal — undocumented but already parsed by `transcript.js`. If
  absent, the chip degrades to the `SessionStart` model / `—`, never throws.
- **Cards flash briefly on a status change** (new). When a session's `status`
  transitions, its card plays a one-shot, subtle pulse (a soft accent glow in the new
  status's color, ~0.6s) so a change is noticeable without staring. Reuses the
  existing per-session transition detection (`App.prevStatus`, already diffed for
  sound cues) and is gated by the same `App.soundsPrimed` flag, so the whole grid
  doesn't flash on first load or after a reconnect resync. Purely a client CSS/class
  addition — no server or data change.

## Goals

- Let a user pin cards to stable alphabetical positions.
- Show, per session, how many subagents and tool calls it has made.
- Show, per repo, which tools are used and how often.
- Make the model chip reflect a mid-session `/model` switch and reveal when a session
  has spanned more than one model.
- Make status changes noticeable at a glance via a subtle card flash.

## Non-goals

- Multi-key/arbitrary sorting, or persisting the sort server-side.
- Per-subagent or per-tool *timing*; a subagent detail view.
- A repo-wide subagent total, or Subagents/Tools cells in the card's repo-total row.
- A model-change timeline, or detecting `/model` before the next assistant turn
  writes to the transcript.
- Changing token, cost, or active-time attribution.
- Reconstructing tool counts for backfilled or event-pruned history: `byTool` is
  event-derived, so a repo with only imported/aged-out history shows Tools = 0 (same
  live-only limit already disclosed for prompts/active in changelog #9). Worth a
  one-line tooltip disclosure, mirroring the repo-total row's existing note.

## Design

### 1. Sort toggle (`web/`)

`index.html` `#view-live` `view__head` gains a `.range` group mirroring the
Per-repo/History range controls (`data-sort="status|name"`, `Status` active by
default). `app.js`:

- `App.liveSort` initialized from `localStorage.getItem("cockpit.liveSort")`,
  default `"status"` (unknown → `"status"`).
- `renderLive` sorts a **copy** of `sessions` when `App.liveSort === "name"`
  (`repoName.localeCompare`, then `cwd`, then `sessionId`); otherwise renders the
  server order (already `compareCards`).
- A delegated `#liveSort` click handler (like `#repoRange`) sets `App.liveSort`,
  writes `localStorage`, toggles `is-active` via `setActiveRange`, re-renders.

No daemon change.

### 2. Live card columns (`web/`)

`cardHTML` stat array becomes `Prompts · Tokens · Cost · Active · Subagents · Tools ·
Age`. Subagents cell = `subagents.total`, `title` = `byType` breakdown + active count.
Tools cell = `num(s.toolCount)`. The `subagents.active > 0` chip is dropped from
`chips`. `rtCells` (repo-total row) is unchanged — it stops after `Active`, so the
three trailing columns stay blank there via grid auto-flow. `styles.css` widens
`.cards` `minmax()` (from 380px) to fit 7 columns without shrinking the stat font;
the exact width is settled in the browser pass.

### 3. Tool counts (`scripts/` + `web/`)

**Per session (live total).** `aggregate.newSession` adds `toolCount: 0`;
`applyEvent`'s `PreToolUse` case does `session.toolCount = num(session.toolCount) + 1`
— the `num()` coercion matters because `loadSnapshot` restores sessions straight from
JSON without running `newSession`, so a session live across a daemon upgrade has no
`toolCount` key and a bare `+= 1` would poison it to `NaN` (same guard the engaged
clock uses for `activeMs`). Snapshot-persisted and replay-safe, like `promptCount`.

**Per repo (breakdown).** `aggregate.createRollup` adds `byTool: {}` on each repo
(via `ensureRepo`). Tool counting is **unconditional** — every `PreToolUse` that
carries a `tool_name` is tallied, independent of the engaged clock. This is a
deliberate divergence from the active-time fold, which is gated on `activeDelta > 0`
(`accumulateActiveFromEvents` aggregate.js and the `handleEvent` fold in daemon.js
both sit inside that guard): a `PreToolUse` can legitimately settle `activeDelta === 0`
(the first event after `rolloverDay` nulls `engagedSince` at midnight, or a tool that
starts engagement from idle), so tying `byTool++` to the active fold would drop those
calls and — if only one of the two paths were gated — make the today figure change on
restart. So the per-day event replay tallies `byTool` on its own `PreToolUse` branch,
and the live `handleEvent` increments `todayRollup.repos[repo].byTool[tool]` on its own
`PreToolUse` branch (not "alongside" the active fold) — same single event-log read,
same live/rescan agreement as active time. `aggregateReposAcrossDates` sums `byTool`
across days; `reposSummary` (`/api/state`) and `buildHistory` topRepos
(`/api/history`) expose it.

Per-repo view (`app.js`): a new **Tools** column in `REPO_COLS`, positioned after
`Tokens` and before `Cost` (activity metrics grouped left of the money column),
showing the total (`Σ byTool`), sortable like other numeric columns, with a `title`
tooltip listing the per-tool breakdown (mirrors how the Tokens column shows a
breakdown tooltip today).

### 4. Current model + used-set (`scripts/daemon.js` + `web/`)

`updateSessionTokens` replaces the dominant-by-output loop:

- `session.model` = model of the most-recent entry in `usage.messages` with both a
  `model` and `output > 0` (iterate from the end; only overwrite when one is found, so
  a transcript with no output-bearing message yet leaves the existing model intact).
- `session.modelsUsed` = `Object.keys(usage.byModel)` minus `"unknown"`, first-seen
  order, capped at 5 for the tooltip (`+N more` beyond).

`toCard` already spreads session fields, so `modelsUsed` reaches `/api/state`. The
card's model chip stays `shortModel(s.model)` with a tooltip: `Models this session:
sonnet-5, opus-4-8 (current)` when `modelsUsed.length > 1`, else just the name.
`transcript.js` is unchanged.

### 5. Flash on status change (`web/`)

`detectSoundCues` already diffs each session's `status` against `App.prevStatus` on
every snapshot. Collect the session IDs whose status changed this update — before
`prevStatus` is overwritten — into an `App.flashed` set, gated on `App.soundsPrimed`
so the first primed snapshot and post-reconnect resyncs don't flash the whole grid.
Any status transition qualifies (running↔idle, →waiting, →error, …). A session
appearing for the first time (no `prevStatus` entry) counts as a transition too, so a
newly-registered card flashes once as a "new session" cue — still suppressed on the
initial primed snapshot / reconnect resync by the `soundsPrimed` gate.
`renderLive` adds a `card--flash` class plus a variant keyed to the NEW status
(`card--flash-waiting|error|running|idle`) to just those cards, so the pulse color
hints the new state. Because `renderLive` rebuilds the cards' `innerHTML` each update,
a CSS keyframe on the freshly-inserted flagged element plays exactly once and unchanged
cards never animate — so no per-tick flicker. `styles.css` defines the keyframe per
variant: a low-opacity accent glow (reusing the existing `--st-*` status colors) that
fades out, deliberately subtle.

## Alternatives considered

- **Sort: alpha within status groups (server-side).** Keeps waiting-first, breaks
  ties alphabetically. Rejected as primary — doesn't give the stable positions that
  motivate alpha sort.
- **Sort: persisted server config.** Syncs across tabs but adds a config field + a
  `PUT` for a trivial per-browser preference. Rejected as heavier than the value.
- **Counts on a secondary line / as chips instead of columns.** Lighter on width, but
  the dedicated-column layout was chosen for prominence; the secondary-line fallback
  stands if 7 columns prove unreadable in the browser pass.
- **Model: keep dominant-by-output, add a "multiple models" hint.** Stable and
  mislabel-proof, but never reflects the *current* model after `/model` — the thing
  being asked for. Rejected in favor of showing current.
- **Model: most-recent message with *any* model (no `output` filter).** Simplest, but
  the newest line is often a usage-only/cache record, so across the 5s poll the chip
  would flicker to a wrong model between real turns. Rejected for the `output > 0`
  filter, which costs one condition and removes the flicker.
