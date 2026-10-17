# Background shell the turn ended on counts as work

A background shell (or Monitor) the main thread **ended its turn on launching** now keeps the
session running and accruing active time until it leaves the registry, capped at 60 minutes.
That is how a test run looks; a dev server is launched and then used, so it stays excluded.
Narrows `2026-09-07-background-shell-exclusion` rather than reversing it.

## Detail

- **Measured before choosing the signal.** Three weeks of real transcripts: 47 turns ended right
  after a background launch; 41 were then woken by that shell's completion, 5 by the user, and
  **zero** were dev servers. Waits ran 0–16 min, plus hour-long browser passes elsewhere.
- **Rejected as the primary signal: Claude's description or command.** Servers get "Run …" just
  like tests ("Run isolated backend on :8612", "Run the operator SPA dev server"), and both
  servers and verifications run as opaque scratchpad scripts. A word-level command match was
  later added as a *second* signal, at the user's request: `2026-10-17-test-command-shells`.
  Also rejected: payload fields. The hook's
  registry entry exposes only `id`/`type`/`status`/`description`/`command`, so it carries no
  `kind`/`startTime`, and a Monitor is `type: 'shell'` like any Bash.
- **Rejected: counting every shell again with an age cap.** Dev servers are constant here. Every
  session that starts one would read Running for the whole cap after Claude finished, and
  "finished" would land an hour late. That hides "your turn", which is worse than today's miss.
- **Binding rules** (`aggregate.foldShellWait`). Only the **last main-thread batch** before
  `Stop` counts, because every main-thread PreToolUse resets the launch list. Subagent tool calls
  (`subagent` flag) neither reset nor launch. A wait carries across a **tool-less** turn and is
  **dropped** by a turn that does other work without ending on a launch. The drop is the
  deliberate conservative edge: it is what releases a `tail -f` Monitor once its run reports.
- **`bg_shell_ids` and `bg_launch` store opaque task ids.** This is the first exception to emit.js's
  counts-only rule, and it is still not content: ids are regex-validated and capped at 50 per
  event. Launches are read from the tool *result* (`backgroundTaskId`), which also catches Ctrl+B
  and auto-backgrounding. A persistent Monitor never counts.
- **The cap has no event.** applyEvent clips a span held open only by the wait at the cap on the
  next event, so a replay matches. The daemon's `checkShellWaitExpiry` only re-broadcasts and fires
  "finished" at the edge, never mutating state. An expiry older than 60s (daemon was down) stays
  silent.
- **Day rollover clears the launch list too** (`shellLaunches`), or a turn whose last launch
  preceded midnight would start a wait live that the per-day replay never sees. A bad-ts event
  never reads a wait as live, and re-engaging after a silent cap expiry re-stamps `engagedStartedAt`.
- **Known limits.** Two launches in *separate* final messages wait only on the last (a test plus a
  later Monitor on it). A tool-using turn mid-wait drops a real wait (that card shows Idle, as
  before). A wait is cleared at day rollover to match the fresh per-day replay. The card's Active
  stat settles at the next event, as it always has.
- **Verified:** 443 `node --test` passes (12 new). Smoke-tested emit.js against an isolated state
  dir. The old and new aggregate replay 17 real days to identical rollups. A scratch daemon was
  driven in a real browser: waiting card Running → Idle with the "done" flash on completion,
  dev-server card Idle, and cap expiry flipped a card with no event. Real payload shapes were
  captured from Claude Code 2.1.302 with a throwaway hook.
- **Not verified:** a real session through the installed plugin. Hooks and the daemon run from the
  plugin cache (v0.56.0), so nothing changes for live sessions until a version bump ships this.
