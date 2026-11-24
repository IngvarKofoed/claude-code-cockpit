# Live cards show a running /feature-flow's step

A card whose session runs `/feature-flow` can show the feature's step, its sub-step and `doing`
text, and an `N/M` counter above the elapsed timer. **Show feature flow** is off by default.
The daemon re-reads the skill's state file by session id every 3s while a dashboard is open.
Its text is served live, never stored or logged, like the session name; no path is ever sent.

## Detail

- **Spec:** `docs/specs/2026-11-24-live-card-feature-flow.md`. **Rejected there:** a browser-polled
  `GET /api/feature-flow` (a second refresh path beside SSE); carrying it through the hooks into the
  event log (free text in the durable log); `fs.watch`; the newest `progress_log` line as live
  detail (`doing` only, so the log is never opened); an amber "Your turn" and a one-line layout.
- **Binding: the projection is live-only.** It sits in the daemon's `flowBySession` map, attached
  per card in `buildStatePayload`. It is never in `saveSnapshot` or `extra`, never appended to a
  log, and a poll failure logs fixed text only, since a JSON parse error can quote the file. This is
  the carve-out to "no content stored or served", on the footing of
  `2026-08-07-live-card-session-title`.
- **Binding: the skill owns the format.** Files below `version` 2 are ignored, and a field the
  module can't find drops its line rather than the block. A session id enters a path only when it
  matches `[A-Za-z0-9_-]{1,128}`, after `bg-tasks.js`'s `TASK_ID_RE`. `flow` is the one `liveShow`
  key read with `=== true`, so a value stored before it existed reads as off.
- **Staleness is decided server-side.** Pending files over 24h old are dropped. `quiet` (not
  waiting, and `updated_at` over 1h old) is part of the compared projection, so crossing the hour
  re-broadcasts without any other event. The dim reuses the stale gauge's 0.55 opacity
  (`2026-08-17-context-gauge-degradation`).
- **Choices the spec left open:**
  - An exact `updated_at` tie goes to the worktree file over the pending one.
  - A pending file with no `updated_at` can't be aged, so it is kept.
  - Files over 64KB are skipped.
  - Strings are whitespace-collapsed and cut at 160 code points with a `…`.
  - `waitingFor` is null unless the flow is waiting.
  - The "no update since" time reuses the usage bars' 24-hour clock and month names
    (`22 Nov 14:02`). The settings row sits right after "Show activity line".
- **Known limits.** A quiet block's second line is faint in the light theme (muted ink at 0.55),
  as specified. Unlike `state.py status`, a worktree file is shown even when its checkout was
  deleted by hand, because the lookup never follows a path read out of the file.
- **Verified:**
  - 21 new tests in `feature-flow.test.js`; `node --test` passes 474 of 477, with 3 Windows-only
    tests skipped.
  - An isolated test daemon fed through `emit.js`, with fixture files written by the real
    `state.py`. A rewrite reached an SSE frame in ~1.8s and the card's DOM in ~2.6s. `quiet`
    flipped ~1s after the hour with no event.
  - Grepping the test store (snapshot, event log, rollups, `daemon.log`) for the feature text
    found nothing.
  - Headless Chrome screenshots in both themes.
- **Not verified:** a real `/feature-flow` session through this machine's daemon. `web/` is served
  from disk, but `daemon.js` changes reach a running daemon only when it is replaced. Until then the
  switch works but no card carries a block.
