# Data management: manual cleanup, delete-repo, drop retention

Replace the cockpit's automatic retention-based pruning with **manual, user-driven
data management**. The daemon stops deleting anything on its own; instead the
dashboard reports the on-disk store size and gives the user two explicit,
irreversible actions: **delete one repository's accounting** (from a `⋯` menu on
the Per-repo page) and **clean up data older than N days** (from Settings). The
`retentionDays` setting and the automatic `pruneOld` timer are removed entirely.
Deletions physically rewrite/remove the JSONL + rollup files, so the reported size
actually drops (Approach A from the design discussion).

## Key decisions

- **Deletion is a hard delete, not a hide** (new). Both actions physically remove
  data from the `events`/`usage`/`rollups` day files so the DB shrinks — the whole
  point of the feature. Rejected a soft `excludedRepos` list (reversible, simpler)
  because it would never free disk. *This is the load-bearing choice — see Resolved
  decisions.*
- **Daemon is the sole executor of all deletes** (extends). Every rewrite/unlink
  runs inside the daemon via authenticated `/api/*` calls, reusing the tmp-write +
  same-dir-rename pattern already inline in `daemon.js` (`persistRollup`/`saveSnapshot`,
  ~1437/1457). It is the only writer of `usage`/`rollups` and of *past*-day `events`,
  so those rewrites are race-free.
- **Delete-repo rewrites the current-day event log too** (diverges). To make
  "delete" complete for today it atomically rewrites `events/<today>.jsonl` — the
  hottest file in the store (every session appends to it) — and **must also reset the
  daemon's tail offset** for that day, or the next tail re-reads the shrunk file and
  double-counts live state (see Design). This bends the invariant at `daemon.js:1565`
  ("never touch the day hooks may be appending to"); justified as a rare, deliberate,
  one-shot action, with a bounded (not negligible) lost-append window and Approach C
  as the documented fallback.
- **Manual cleanup only unlinks whole past-day files** (reuses). "Older than N days"
  deletes entire `YYYY-MM-DD.*` files older than the cutoff, never today's — exactly
  the safe subset of the old `pruneOld`. N is entered at click-time, **not** a
  persisted setting.
- **`retentionDays` and auto-prune removed** (breaking). Dropped from
  `DEFAULT_CONFIG` and `validateConfig` in `config.js`, and the
  `setInterval(pruneOld, …)` + `pruneOld()` from `daemon.js`. History is now
  **unbounded** until the user cleans up. A persisted `retentionDays` goes inert
  (unknown keys are already dropped by `validateConfig`) — technically no migration,
  but this silently flips a user who set `retentionDays: 30` to bound disk into
  unbounded growth, so it **must** be called out in the changelog/release notes.
- **Disk size is computed on demand, never on the hot path** (new). A new
  `GET /api/storage` sums file sizes under the three store dirs; the SPA fetches it
  only when Settings opens and after each mutation — never in `buildStatePayload`,
  which runs on every SSE frame.
- **New Per-repo `⋯` action menu** (new). The Per-repo table gains a trailing
  action cell; the dashboard has no existing menu/dropdown component, so this is a
  small new UI primitive.

## Goals

- Never delete accounting data automatically; the user decides what goes and when.
- Show how much disk the store is using, so the user knows when cleanup is warranted.
- Let the user permanently delete a single repository's accounting.
- Let the user prune all data older than a chosen age, on demand.
- Reported store size drops after a delete/cleanup (deletions are real).

## Non-goals

- **No automatic cleanup, ever** — no timer, no retention, no size cap.
- **No per-repo retention or scheduling.** Cleanup is a manual, whole-store, age-based action.
- **No undo / trash.** Deletes are irreversible (confirmed in-app first).
- **No "wipe everything" button** (see Resolved decisions) — per-repo delete + age-cleanup cover it.
- Live-session state and the transcript files under `~/.claude/projects` are untouched — this manages only the cockpit's own store under `stateDir`.

## Design

### Storage size — `GET /api/storage`

New authenticated endpoint. Walks `paths.eventsDir()`, `paths.usageDir()`,
`paths.rollupsDir()` (plus `paths.snapshotPath()`), summing `fs.statSync(f).size`,
and derives the day span from the `YYYY-MM-DD` filenames:

```json
{ "bytes": 12934221,
  "dirs": { "events": 8100000, "usage": 4200000, "rollups": 634221, "snapshot": 132 },
  "days": 47, "oldestDate": "2026-05-17", "newestDate": "2026-07-03" }
```

`days` is the count of distinct `YYYY-MM-DD` dates present across the three dirs
(their union), and `oldestDate`/`newestDate` are the min/max of that union — a
file count, not a calendar span (a gap day simply isn't counted). `daemon.log` is
excluded — it's a log, not accounting data. Computed synchronously per request (a
directory stat of a few dozen small files is cheap) and **not** memoized, since it's
only hit on Settings open and after a mutation.

### Manual cleanup — `POST /api/data/cleanup`

Body `{ "olderThanDays": N }` (N ≥ 1). Cutoff = `paths.dateStr()` minus N days.
For each of the three store dirs, unlink every `YYYY-MM-DD.*` file whose date is
`< cutoff` **and** `!== currentDate` — the same guard `pruneOld` used. Returns
`{ ok, deletedDays, freedBytes }`. On success the daemon clears `rollupCache` and
sets `repoTotalsCache = null` (a pruned day drops out of every range aggregate),
then `markDirty()` to refresh open dashboards.

This is the safe subset: whole-file unlinks of inactive past days, no line-level
rewrites, no concurrent writers.

### Delete a repo — `POST /api/repos/delete`

Body `{ "repoRoot": "<abs path>" }`. **Refuses with `409`** if any live
`state.sessions` entry has this `repoRoot` (see Resolved decisions) — so the delete
only ever runs against a repo with no in-flight session, and can't be silently
re-populated. Then it removes every trace from the store. In each store, a file left
with no remaining lines/repos is **unlinked**, not left as a 0-byte file (so it stops
counting toward `days`/`oldestDate`):

1. **Usage logs** — for each `usage/*.jsonl`, read lines, drop those with
   `repo_root === repoRoot`, atomic tmp+rename (unlink if empty). Daemon is sole
   writer — race-free.
2. **Rollups** — for each persisted `rollups/*.json`, delete `.repos[repoRoot]`;
   rewrite (unlink if `repos` is now empty).
3. **Past-day event logs** — same line-filter + atomic rename (unlink if empty).
   No writers, so race-free.
4. **Current-day event log** — the sharp edge. `events/<today>.jsonl` is the hottest
   file in the store, and the daemon tails it by a persisted byte offset
   (`offsets[currentDate]`, `daemon.js:66/578`); `readNewLines` treats `size < offset`
   as truncation and restarts from 0 (`daemon.js:543`). A naive shrink-rewrite would
   make the next `tailOnce` (≤500 ms later) re-read the whole filtered file and
   re-apply every surviving line via `handleEvent` — silently double-counting live
   state for the *other* repos. So the sequence must be: (a) `tailOnce()` to drain the
   file so the offset equals its size (no about-to-be-processed tail lines are lost);
   (b) read → filter out `repoRoot` → atomic tmp+rename; (c) set `offsets[currentDate]`
   to the **new** file size and `saveSnapshot()`, so the next tail sees "fully
   processed", not "truncated". Even so, an `emit.js` append landing in the read→rename
   window is lost; the window is bounded by that read+write duration × the concurrent
   append rate across all repos — small, but not "one line at the instant of rename".
   If this proves too sharp, Approach C (leave today's event file; it re-derives at
   rollover) is the fallback.
5. **In-memory** — after the rewrites, `rebuildTodayRollup()` re-derives `todayRollup`
   from the now-filtered logs; clear `rollupCache`; set `repoTotalsCache = null`;
   `markDirty()`.

Returns `{ ok, repoRoot, freedBytes }`.

Because usage records are message-id-keyed, dropping a repo's usage lines also drops
its ids from the `countedIdsBySession` seed — so if that repo's transcripts are later
`/cockpit:backfill`ed, they re-import cleanly. That's the intended "deleted → gone,
re-importable" behavior.

### Config & daemon changes

- `config.js`: remove `retentionDays` from `DEFAULT_CONFIG` (line 45) and from the
  numeric-validation loop (line 212). No new migration — `validateConfig` already
  drops unknown keys, so a stored `retentionDays` goes inert on the next write.
- `daemon.js`: delete `pruneOld()` (1550) and its `setInterval(pruneOld, PRUNE_MS)`
  (1606) + the `PRUNE_MS` constant. Nothing else calls it.
- Update the stale "up to the retention limit" wording in the `repoTotals` tooltip
  (`app.js:414`) and the `repoTotalsAllTime` comment (`daemon.js:~999`) — the figure
  is now simply all retained history, which is unbounded until manual cleanup.

### Dashboard

- **Per-repo (`index.html` view-repos, `app.js` REPO_COLS/renderReposTable):** add a
  trailing action cell rendering a `⋯` button. Clicking opens a small menu with
  **"Delete repo data…"**. Selecting it shows an **in-app** two-step confirm (repo
  name + "this permanently deletes all accounting for this repo") — not a native
  `confirm()`. Confirm → `POST /api/repos/delete` → toast + `refreshState()` + re-fetch
  storage. The `repoRoot` is already on each row (`App.repoRows[].repoRoot`).
- **Settings (`app.js` settingsHTML):** rename the "Thresholds & retention" section
  to **"Thresholds"** and remove the Retention field (and `retentionDays` from
  `readSettingsForm`, line 858). Add a new **"Data"** section: shows store size + day
  span from `GET /api/storage`, and a cleanup control — a number input (`N` days) +
  a **"Clean up"** button. Its in-app confirm **previews the concrete scope before
  committing** — e.g. "delete X of Y days (~Z MB), keeping the most recent N",
  computed from the `GET /api/storage` day span — because a mistyped `N` on an
  irreversible whole-store delete is otherwise unrecoverable. Confirm →
  `POST /api/data/cleanup`. Storage is fetched on Settings render and refreshed after
  any mutation.

Per `web/CLAUDE.md`, the build phase reads `dataviz`/`frontend-design` before the
UI work and verifies in a real browser.

## Resolved decisions

These were the design's open questions, resolved to their defaults (confirm or
override on review):

- **Deletion model:** Approach A (hard delete) over B (soft exclude) / C (hybrid) —
  the feature exists to shrink the on-disk store, so deletion must actually delete.
- **Delete-repo with a live session:** refuse with `409` ("close the session first"),
  so a delete can't be immediately re-populated by in-flight events.
- **"Delete everything" action:** no — per-repo delete + age-cleanup cover the cases;
  a one-click nuke is easy to hit by accident and is a non-goal.
- **`GET /api/storage` scope:** count the three store dirs + `snapshot.json`; exclude
  `daemon.log` (a log, not data).

## Alternatives considered

- **B — Soft exclusion list.** Delete-repo adds `repoRoot` to a persisted
  `excludedRepos` the daemon filters out everywhere. Reversible and race-free, but
  the DB never shrinks on delete — which defeats the disk-management goal — and an
  excluded repo silently reappears if used again. Rejected.
- **C — Hybrid (hard-delete past days, leave today).** Avoids the current-day event
  rewrite by never touching `events/<today>.jsonl`; today's data re-derives at the
  next rollover. Safe, but "delete" stays visibly incomplete until midnight — a
  confusing wart on a delete button. Rejected in favor of A's completeness.
- **Keep retention as an optional cap alongside manual tools.** Rejected — the
  explicit requirement is "do not automatically clean up the DB, ever," so any
  automatic timer contradicts the goal.
