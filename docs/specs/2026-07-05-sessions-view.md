# Sessions view: list all sessions from transcripts, newest first

A new top-level **Sessions** dashboard view that lists *every* Claude Code
session Claude Code still retains on disk — not just the ones the cockpit is
tracking live — newest at the top, paginated. Each row shows the session's
AI-generated name (the transcript `ai-title`), its repository, when it was last
active, and its token/cost totals; sessions that are **currently live** are
badged as active. The list source is the transcript filesystem
(`~/.claude/projects/*/*.jsonl`), the same files `backfillTranscripts` already
enumerates — so coverage includes pre-cockpit sessions and nothing new has to be
persisted. This is Approach A from the design discussion.

## Key decisions

- **Source is the transcript filesystem, not the cockpit's own store** (reuses).
  A new `GET /api/sessions` enumerates `claudeProjectsDir()` exactly as
  `backfillTranscripts` (`daemon.js:441`) does — `readdirSync` the projects dir,
  then each `<encoded-cwd>/<session_id>.jsonl`. The filename minus `.jsonl` is the
  `session_id` (same as backfill's `f.slice(0, -6)`). *This is the load-bearing
  choice:* the cockpit deliberately drops ended sessions (no session-history
  store — changelog entry 6), and `ai-title` lives only in transcripts, so the
  filesystem is the only complete source. Rejected the event-log index (post-install
  only, still needs transcript reads) and a new materialized store (a whole new
  writer with the full idempotency/crash-safety burden — over-scoped for a list view).
- **Server-side pagination: stat-all, parse-page** (new). The endpoint `fs.stat`s
  every transcript (cheap) to sort by mtime and count the total, but only *opens and
  parses* the ~`pageSize` files on the requested page. Per-request parse cost is
  bounded by page size, not by the total session count (hundreds of files).
- **Sort by transcript mtime, descending** (new). mtime is the real last-write time,
  so it is the authoritative "newest / most-recently-active" ordering and needs no
  content parse to compute. Live sessions are being written right now, so they
  naturally float to the top of page 1 — aligning "newest first" with "active on top".
- **`transcript.readUsage` extended, not duplicated** (extends). The Sessions row
  needs token totals *and* the title — both derivable in the single pass `readUsage`
  already makes over the file. Add **one** field to its return: `title` (the **last**
  `ai-title`'s `aiTitle`; a session re-titles as it grows), leaving every existing field
  and the hot-path callers untouched. `cwd` is already returned; "last active" comes from
  the file's mtime (no in-content timestamp needed). Avoids a second full-file read.
- **Two caches: a short-TTL stat/sort snapshot + a per-file parse cache** (new). The
  per-request stat-all sweep (needed to sort and count) is O(total), so it must not run
  on every request — ARCHITECTURE keeps such synchronous scans off the live path
  (cf. `computeStorage`). A ~3s-TTL snapshot of the sorted `(path, mtimeMs)` list + total
  is reused across rapid paging; and a `Map<path, {mtimeMs, size, meta}>` memoizes each
  parsed row so paging back and forth doesn't re-parse unchanged transcripts (an active
  session's growing file changes mtime → re-parsed). Mirrors the `rollupCache`
  memoization in `daemon.js` (`getRollup`, ~1044).
- **"Active" is a client-side overlay, not a server field** (reuses). The endpoint
  returns pure transcript-derived rows with a `sessionId`; the SPA already streams the
  full live set in `App.state.sessions`, so it marks a row active by intersecting
  `sessionId` with that map and reuses the Live card's `effectiveStatus` + ticking timer
  for the badge. Because the overlay already keeps *listed* rows' badges/timers live from
  the stream, the page does **not** refetch the endpoint on every SSE frame — it refetches
  only on page nav and view (re)open, so the O(total) sweep isn't paid every ~2s.
- **Titles always shown, but `last-prompt` is never surfaced** (extends the privacy
  model). `ai-title` is an AI-*derived* summary label — comparable in sensitivity to the
  repo and branch names already shown on Live cards — so it is shown unconditionally, with
  no toggle. The transcript's `last-prompt` entry is the user's **verbatim** prompt text
  and is categorically excluded — it would breach the hard "no message content" boundary.
  That line *is* the privacy boundary this view draws: the derived label yes, the raw
  text never.
- **New nav tab + view section + `renderSessions`** (reuses). A `data-view="sessions"`
  tab (placed after Live, both being session-centric), a new `<section>`, and a
  `renderSessions`/`loadSessions(page)` pair that fetches the endpoint. The current
  page fetches on view (re)open and on Prev/Next — not on every SSE frame; the
  client-side active overlay (above) is what keeps listed rows' badges/timers fresh.

## Goals

- One place to see every session Claude Code retains, newest first, by name.
- Make it obvious at a glance which listed sessions are running right now.
- Reuse the existing transcript enumeration, `transcript.js`, and `repo.js` — add no
  new persisted store and no new writer.
- Keep per-request cost bounded — pagination + a parse cache bound the *parse* cost, and
  a short-TTL stat/sort snapshot bounds the *sweep* cost — so the view is usable with
  hundreds of transcripts and never blocks the daemon's live path.

## Non-goals

- **No session drill-down / detail view.** This is a list only. Per-session history is
  a possible follow-up (and the reason C might return later).
- **No message content.** No prompt/response text, and specifically not `last-prompt`.
  Only the derived title, repo metadata, timestamps, and token counts.
- **No new persistence.** Ended sessions are still not stored by the cockpit; the view
  reads Claude Code's files live. (Consequence in Design.)
- **Not tied to cockpit data cleanup.** `POST /api/data/cleanup` and
  `/api/repos/delete` operate on the cockpit's own store, not Claude Code's
  transcripts — so a repo deleted there still lists its sessions here. Called out below.

## Design

### Endpoint

`GET /api/sessions?page=<n>&pageSize=<m>` (authenticated + Origin-checked like every
other `/api/*` route; wired beside the others at `daemon.js:1676`). Response:

```json
{
  "now": 1751706900000,
  "page": 1,
  "pageSize": 50,
  "total": 293,
  "sessions": [
    {
      "sessionId": "78853998-…",
      "title": "Get session names",
      "repoName": "claude-code-cockpit",
      "repoRoot": "/Users/ingvar/private/claude-code-cockpit",
      "lastActive": 1751706880000,
      "tokens": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
      "cost": 0.42
    }
  ]
}
```

Steps: enumerate transcripts exactly as `backfillTranscripts` does — the projects dir
holds only **subdirectories** (`<encoded-cwd>/`), so `readdirSync` the projects dir, then
`readdirSync` each subdir for `*.jsonl` (a flat scan of the projects dir finds nothing).
`statSync` each file for `mtimeMs` → sort mtime-desc → `total` = file count → slice
`[page*pageSize, +pageSize]` → for each file on the slice, look up the parse cache (below)
or parse via `readUsage`, resolve the repo from the transcript's recorded `cwd`
(`repoLib.resolveRepo`), and — only when `cfg.cost.enabled` — price via
`pricing.estimateCost(byModel, cfg.cost.rates)` (else `cost: null`, matching
`backfillTranscripts` at `daemon.js:523` and the UI's `costEnabled()`). `pageSize`
defaults to **50** and is **clamped to `[1, 100]`**; `page` is coerced to a non-negative
integer (NaN/negative → 0) and an out-of-range page returns an empty `sessions` array
with the correct `total`. Clamping `pageSize` is what keeps `?pageSize=99999` from parsing
the whole store in one synchronous request.

### Listing lenience — every transcript is a row (differs from backfill)

`backfillTranscripts` skips a transcript when `!usage.ok || messages.length === 0 ||
!usage.cwd` — right for *accounting*, wrong for a *list*. Every `.jsonl` file is exactly
one session and gets exactly one row, so **no file is ever dropped**. This keeps `total`
(the stat-count) equal to the number of rendered rows, so "page X of Y" and page fill are
exact — the alternative (drop unparseable files) makes `total` overcount and trailing
pages under-fill, since off-page files aren't parsed to know. Degradation per file:
- no usage → tokens zeroed, `cost` 0/null;
- unreadable/empty transcript (`!usage.ok`) → a minimal row (session id + mtime), `title`
  null, repo from the dir-name fallback below;
- `cwd` absent → `repoName` is the decoded project-dir name (best-effort; `/`↔`-` is
  lossy) and `repoRoot` is null.

### transcript.js extension

`readUsage` gains, in its existing single pass, one capture: on `obj.type === "ai-title"`,
overwrite `result.title` with `obj.aiTitle` (last wins). One `if` per line, no change to
existing fields or to the shape hot-path callers depend on, behind the same
version-tolerant, never-throw contract — a missing `ai-title` just leaves `title: null`.

### Caches & consistency

Two module-level structures in `daemon.js`. (1) The stat/sort snapshot: the sorted
`(path, mtimeMs)` array + `total`, rebuilt when older than ~3s, so rapid Prev/Next reuses
one sweep instead of re-stat-ing the whole store per click. (2) The parse cache
`Map<path, {mtimeMs, size, meta}>`: reuse `meta` iff `mtimeMs` and `size` match the fresh
stat, else parse and store — bounded to the transcript count (an optional LRU cap is a
noted follow-up, not needed for v1). Within one request ordering is consistent; a
concurrent write between snapshot windows can shift ordering slightly — acceptable for a
session list, not worth locking.

### Frontend

`index.html`: add the nav button and a `<section id="view-sessions">` holding a table
(Name · Repo · Last active · Tokens · Est. cost, plus a leading active-status cell) and
Prev/Next + "page X of Y" controls. `app.js`: `App.view` gains `"sessions"`; `setView`
renders it; `loadSessions(page)` fetches and renders. Column/cell rules:

- **Name** — `title` when present; when null (~19% of sessions) a muted fallback
  "Untitled session · `<sessionId first 8>`". Never the `last-prompt` text.
- **Last active** — relative mtime ("3h ago") for a past row; for a **live** row that is
  running/engaged this cell instead shows the ticking elapsed timer reused from the Live
  card, so the single time-cell reads as either "when it last ran" or "how long it's
  running now".
- **Active status** (leading cell) — a row checks `App.state.sessions[sessionId]`; if
  present it shows the live status badge via `effectiveStatus` (running / waiting / idle),
  otherwise the cell is blank (a plain past session).
- **Est. cost** — hidden entirely when cost display is off, matching the Live/Per-repo
  views' `costEnabled()` gate.

The page fetches on view (re)open and on Prev/Next — not on every SSE frame; the
client-side active overlay is what keeps listed rows' badges/timers fresh. **Empty
state:** if the projects dir is missing/unreadable (`readdirSync` throws — the same
catch-and-continue backfill uses) or there are zero transcripts, the view shows a "No
sessions found" message instead of an empty table.

### Consequence: independent of cockpit retention

Because the view reads Claude Code's transcript directory directly, it reflects **Claude
Code's** retention, not the cockpit's. A repo deleted via `/api/repos/delete`, or days
removed via `/api/data/cleanup`, still appear here as long as Claude Code keeps the
transcript. This is a deliberate divergence from the Per-repo/History views (which read
the cockpit store); it is the price of complete coverage with no new store, and should be
noted in the changelog.

## Alternatives considered

- **B — Event-log-derived index.** Build session_id→meta from the cockpit's own
  `events/*.jsonl`. Covers only post-install sessions, is O(all events) to scan, and
  *still* needs a transcript read per row for the title. Strictly less coverage than A for
  more work.
- **C — Materialized session-history store.** Persist a record per session on
  Start/Stop/End. The "proper" fix for the dropped-ended-sessions gap and a prerequisite
  for future drill-down, but a whole new writer carrying byte-offset idempotency,
  crash-safety, day-rollover, and delete/cleanup integration — plus a backfill pass for
  pre-existing sessions. Over-scoped for listing sessions; revisit if a detail view is
  wanted.
