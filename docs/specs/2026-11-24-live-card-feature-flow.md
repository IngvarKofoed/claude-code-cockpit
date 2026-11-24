# Live card: activity-line toggle and feature-flow status

Two per-browser Live-card switches in Settings ▸ Dashboard. **Show activity line** (on by
default) hides the card's "Working…" line with its spark dot, the way the name, branch and path
lines can already be hidden. **Show feature flow** (off by default) adds a block just above the
elapsed-time timer of a card whose session is running `/feature-flow`, as three stacked lines:
the step name, the sub-step with what it's doing, and a large `x/10` step counter. The daemon
finds each live session's feature-flow state file by session id, re-reads it every ~3s, and
ships a short allowlisted projection on the existing `state` SSE frame. Nothing about it is ever
written to the cockpit's own store.

## Outcome

**What you get:**

- A **Show activity line** switch that removes the "Working…" / status line, with its dot, from
  every Live card in this browser.
- A **Show feature flow** switch, off by default. When on, every card whose session is running
  `/feature-flow` shows, just above its elapsed-time timer, that feature's step name, its
  sub-step and what it's doing, and a big step counter (`4/10`). The block updates within a few
  seconds of the skill moving on, without a reload.
- A feature flow waiting on you reads **"Your turn: …"**, and one that has gone quiet for an hour
  dims, so a forgotten design session is visible at a glance.

**How to verify:**

- Turn Show activity line off: every card loses that line, no "Settings saved" toast appears,
  and it stays off after a reload.
- Turn Show feature flow on while a session runs `/feature-flow`: its card shows e.g.
  `Design` / `Research · reading the code` / `1/10`, and every other card has no block. When the
  skill next runs `state.py set`, the card follows within ~3s.
- When the skill puts a question to you, the second line reads `Your turn: answer my questions`,
  muted like any other status, while the card's own badge still says Idle.
- After a session has shown a feature whose `doing` text is something distinctive (e.g.
  `zebra-probe-42`), grep `snapshot.json`, the day's event log and `daemon.log` for it: nothing
  matches.

## Key decisions

- **Daemon reads, card carries it** (extends). A daemon timer resolves each live session's file
  and attaches `featureFlow` to its card in `buildStatePayload`, broadcasting only on change.
  This is the same shape as the context gauge: per-session data drawn from an outside source,
  omitted when absent. Chosen over a browser-polled endpoint (Alternatives).
- **Keyed on `session_id`, found from the session's git dir** (reuses). The common git dir
  comes from the session's `repoRoot` `.git` entry, using the `gitdir:` reading `repo.js`
  already does. Then the lookup is `feature-flow-pending/<sid>.json`, else a scan of
  `worktrees/*/feature-flow-state.json` for a matching `session_id`. No subprocess, no
  `fs.watch`.
- **Read-only, live-only, allowlisted** (new). The cockpit never writes these files. The
  projection keeps a fixed set of fields, clamps every string, and never sends a path (repo,
  worktree, spec, log). It lives in an in-memory map the snapshot never saves, and it is never
  appended to the event log, so the feature's free text gets the session name's footing: shown,
  never stored.
- **A pure module with its own tests** (extends). `scripts/feature-flow.js` covers the
  git-dir → file lookup, staleness rules and projection, and never throws, in the shape of
  `repo.js`. `feature-flow.test.js` builds fixture git dirs in a tmp folder, as `repo.test.js`
  does. The daemon keeps only the timer, the map and change detection.
- **Feature-flow switch defaults off** (diverges). Every other `cockpit.liveShow` key defaults
  on under a `!== false` guard. `flow` uses `=== true`, so a stored value written before it
  existed reads as off, which is what the user asked for. `activity` follows the usual default-on
  guard.
- **Staleness is decided server-side** (new). The projection carries `quiet` (not waiting for
  the user and `updated_at` over 1h old). The daemon drops pending files whose `updated_at` is
  over 24h old. Because `quiet` is part of the compared projection, crossing the hour triggers a
  broadcast on its own, so an idle card with no other events still dims on time.
- **"Your turn" is words, not colour** (reuses). It reads `Your turn: …` in the same muted ink
  as any other status, with no amber. The status colours stay with the card's rail and badge,
  which show the session as Idle because its own turn is over. The feature flow is waiting, not
  the session.
- **The status is `doing`, never the progress log** (new). The projection carries the state
  file's `doing` text only. `progress_log` is never opened, so line 2 changes when the skill runs
  `state.py set`, not while a builder logs progress.

## Goals

- Let the user reclaim the activity line's height, like the other location lines.
- Show, on the card itself, where a running feature flow is and whether it needs the user.

## Non-goals

- Writing to, cleaning up or resuming feature-flow files. They belong to the skill.
- Feature-flow status anywhere but the Live card: no Sessions or Repos column, no notification,
  no sort key, no group-rail effect.
- Showing feature flows whose session the cockpit has no live card for (dead sessions, other
  machines). `/feature-flow status` already lists those.
- Any change to the activity line's content, or to `activityDetail`.

## Design

### The activity-line switch

`cardHTML` (`web/app.js`) renders `.card__activity` only when `App.liveShow.activity` is on. The
Settings row "Show activity line" goes after "Show folder path". Its description says the line
also carries the current tool, "Waiting for your input" and a failed turn's reason, which the
badge alone doesn't spell out. Both new keys are added explicitly in two places:
`App.liveShow`'s default object (`activity: true, flow: false`), because `setLiveShow` ignores a
key it doesn't already hold, and the `init` load guard (`activity: v.activity !== false`,
`flow: v.flow === true`), which rebuilds the object key by key. Only the `set-show-*` change
handler is generic.

### Finding the file (`scripts/feature-flow.js`)

- **Common git dir.** Read `<repoRoot>/.git`. A directory is the common dir itself. A file's
  `gitdir:` target is a linked worktree's private dir when its parent is named `worktrees`, so
  the common dir is two levels up. Any other target (a submodule) is taken as its own common
  dir, which harmlessly finds nothing. `repoRoot` follows the session's cwd per event, so a
  session in its feature worktree and one back in the main checkout for shipping both resolve to
  the same common dir.
- **Lookup, per common dir per tick.** For each live session there, collect every candidate:
  `feature-flow-pending/<sid>.json`, plus any match from one scan of
  `worktrees/*/feature-flow-state.json`, read once per tick and shared by every session of that
  repo. The newest `updated_at` wins. That covers a session that left one feature waiting and
  started another, and an abandoned pending file next to a resumed worktree feature, since the
  skill only deletes a pending file when a worktree adopts it. A session id is used in a path
  only when it matches a strict id pattern (letters, digits, `-`, `_`), in the manner of
  `bg-tasks.js`'s `TASK_ID_RE`; any other id skips the lookup.
- **Tolerance.** Missing or unparseable files are skipped, unknown fields are ignored, and a file
  whose `session_id` doesn't match its lookup key is ignored. A file with `version` ≥ 2 is read,
  and a field the module doesn't find just drops its line from the block rather than hiding the
  feature. A missing or lower `version` is ignored. A missing or unparseable `updated_at` gives
  `updatedAt: null` and `quiet: false`, and loses any tie. An exact `updated_at` tie goes to the
  worktree file, the one the skill has adopted. A state file over 64 KB is skipped. A worktree
  file whose checkout was deleted by hand still shows, because the lookup never follows a path
  read out of the file.
- **The format belongs to the skill.** The cockpit tracks it, it doesn't own it. If the skill's
  format drifts past what the module can read, the block disappears; nothing breaks.
- **Projection**, the only thing that leaves the module, sent as `card.featureFlow` or `null`:

  ```
  { title, stepNumber, stepTotal, stepLabel, subStep, doing,
    waitingForUser, waitingFor, quiet, startedAt, updatedAt }
  ```

  - `stepLabel` is `step` with its leading `N/M ` stripped ("Design", "Building", "Feedback
    round 2").
  - `subStep` is `step_name` only when it differs from `stepLabel` ("Research", "Draft",
    "Push"). It is `null` on build steps, where the two match.
  - Timestamps are epoch ms. Strings are clamped to 160 characters.

### The daemon (`scripts/daemon.js`)

- `pollFeatureFlow()` runs every `FLOW_POLL_MS = 3000` over non-ended sessions and rebuilds a
  module-level `flowBySession` Map. A projection that differs from the previous one, by
  `JSON.stringify`, or a session gaining or losing one, marks the state dirty through the
  existing coalesced broadcast.
- The poll is skipped while no SSE client is connected. It runs once synchronously when a client
  connects, before that client's initial snapshot is written, so a fresh tab never shows a
  missing block for 3s. `/api/state` reads the same map, and first runs the poll whenever the
  map is older than `FLOW_POLL_MS`, so a fetch made with no stream open never serves a step
  from the last time a dashboard was connected.
- `buildStatePayload` attaches `featureFlow` to each card from the map. `toCard` and `aggregate`
  are untouched, and the map is neither in `saveSnapshot` nor in `extra`.

### The card block (`web/app.js`, `web/styles.css`)

When `App.liveShow.flow` is on and `s.featureFlow` is non-null, `cardHTML` renders a
`.card__flow` block **just above the `.telemetry` row**, the elapsed-time timer. It follows the
activity line, or the location lines when that line is hidden. It has no heading and does not
show the feature's title. It stacks three lines, each one dropped when it has nothing to show:

1. **The step name**, in a fairly large weight: `stepLabel` (`Design`, `Building`).
2. **The sub-step and what it's doing**, muted and smaller, joined by ` · `:
   `Research · reading the code`. On a build step there is no sub-step, so it reads the `doing`
   text alone. While `waitingForUser` is set the whole line is `Your turn: <waitingFor>` instead,
   in the same muted ink. While `quiet` is set the `doing` part becomes
   `no update since <local time of updatedAt>`, with the date in front when it isn't today
   (`no update since 22 Nov 14:02`), and the block dims to the stale opacity the context gauge
   uses. That text is fixed, so the 1s tick never repaints it.
3. **The step counter** `stepNumber/stepTotal`, on its own line below line 2, **right-aligned**
   to the card's edge and larger than line 1, mono with tabular numerals in the spirit of
   `.telemetry__value`. It is omitted when either number is missing.

Lines 1 and 2 are single lines that ellipsize when too long, so a long `doing` text never
changes the card's height. Sizes: the step name is 17px semibold, line 2 is 12px muted, and the
counter is 38px mono with its `/10` part muted. "Your turn" is semibold in the same muted ink,
and reads `Your turn` alone, with no colon, when `waitingFor` is empty. The counter carries an
`aria-label` ("step 4 of 10"). A tooltip on the block gives the feature's title and its started
and last-updated times.

Mockup: https://claude.ai/artifact/V7BhZjFhYkbxre7E1xCkhE (version 5: three lines above the
elapsed timer, no heading, counter right-aligned), the look to match.

### Docs

`docs/ARCHITECTURE.md` gains a short *Feature-flow status* subsection under the daemon covering
the source, lookup, cadence, allowlist and never-stored rule. Its Live view bullet names the two
switches. Its *Security & privacy* paragraph, and the "no transcript content is stored or
served" principle in `docs/CONCEPT.md`, gain the carve-out this spec argues for: a feature
flow's title and status text are served live, on the session name's footing, and never stored.
`docs/CONCEPT.md`'s live-overview capability gains one clause for the optional feature-flow
step. The work lands as two changelog entries, since the activity switch is an independent
change.

## Alternatives considered

- **Browser-polled `GET /api/feature-flow`, only while the switch is on.** It does no work when
  off, but gives the card a second refresh path with its own timing beside SSE. Rejected in
  design: the saving is a few tiny reads per repo.
- **Carry it through the hooks into the event log.** That would put the feature's free text into
  the durable log, against the no-content rule, and still arrive only on the next hook.
- **`fs.watch` on the git dirs.** Ruled out by the architecture: no `fs.watch` for correctness.
- **The newest `progress_log` line as live detail.** It would keep line 2 moving through
  Building. Declined in design: `doing` only.
- **Amber "Your turn", or step and sub-step on one line.** Both declined in design. The layout
  is three lines, and the waiting cue is the words.

## Implementation strategy

*Not part of the design — a starting point for whoever builds this.*

- **Multi-agent: the lead plus 1 chunk, in parallel.** The lead builds `scripts/feature-flow.js`
  with its tests, then the daemon poll, map and payload wiring, then the docs and the two
  changelog entries. A subagent builds the web side (both switches, `.card__flow`, its CSS)
  against the projection shape pinned above, using a hand-made payload until the daemon lands.
- **Opus 5.5 lead, Sonnet 5.5 for the web chunk.** The lookup and staleness rules carry the
  `(new)` decisions. The UI follows a settled shape and the mockup.
