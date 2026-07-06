# TODO

Deferred ideas and follow-ups. Not commitments — context for a future agent.

## Forked / background sessions

- **[BUG — confirmed] Forked sessions double-count tokens/cost.** A `--fork-session
  --resume <parent>.jsonl` fork copies the parent's transcript history into its own
  transcript *keeping the same message-uuids*. Token dedup (`seenIds`, daemon.js:66)
  is keyed per `session_id`, so the fork re-counts every message the parent already
  billed — inflating the shared repo's tokens + estimated cost. Verified live:
  requirements-buddy sessions `af1da441` (parent) and `df7d7a35` (fork) share **41
  message-ids** across their usage logs, same repo_root. Violates the architecture's
  stated id-keyed idempotency invariant (which holds within a session, breaks across
  forks). Fix direction: dedup attribution by message-uuid across the repo (or
  globally — uuids are globally unique, so cross-session dedup only ever collapses a
  fork's genuine copies, never distinct messages), backed by an in-memory global
  counted-set so a *concurrent* parent+fork can't both count an id before the other's
  usage record is flushed. Core-accounting change → spec it before patching.


Claude Code runs some work as a **separate `claude` OS process** that *forks* the
launching session's transcript into a new session-id, driven headlessly by the
Claude Code background daemon (`claude daemon run --origin transient` →
`claude --bg-pty-host …` → `claude --fork-session --resume <parent>.jsonl
--reply-on-resume`). It has no terminal of its own.

- **Reconcile with the active-time model.** `ARCHITECTURE.md` assumes background
  work arrives as `workflow-subagent` `SubagentStart`/`SubagentStop` hooks *on the
  parent session* (folded into the parent's active time + agent counts). But a
  `--fork-session` fork fires its **own** `SessionStart` and gets its **own**
  session-id, so the cockpit books it as a fully independent session (own card,
  own active-time clock) — not as a subagent of the parent. Both models exist in
  the wild; the docs describe only the first. Decide the intended behavior and
  document it (and check active-time isn't double-counted or orphaned across the two).

- **Flag forked/headless sessions on the Live card.** Today a background fork looks
  identical to a foreground terminal session — same card, no way to tell it has no
  console. It even shares the **same name**: it inherits the parent's `cwd` (→ same
  repo name on the Live card) and was made with `--resume <parent>.jsonl` (→ same
  transcript `ai-title` in the Sessions view until it writes its own), so the two are
  genuinely indistinguishable in the UI. The provenance is visible in the OS process tree
  (`--fork-session` / `--bg-pty-host` / `--spawned-by`) but **not** in the hook
  payloads, so surfacing it needs a source of that signal (owner-PID command-line
  inspection, or a new hook field if Claude Code adds one). Then badge such a card
  ("forked" / "background", no terminal attached) so two sessions + one console
  reads as expected rather than as a phantom.
