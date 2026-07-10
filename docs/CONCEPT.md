# claude-code-cockpit — Concept

## Summary

A [Claude Code](https://docs.claude.com/claude-code) plugin that gives you a live, cross-platform **mission control** for every Claude Code session you have running. Where [claude-code-notifier](https://github.com/IngvarKofoed/claude-code-notifier) tells you *when a single session* needs you, the cockpit shows you **everything happening across all sessions at once**: which prompts are running, in which repository, for how long, what Claude is doing right now, and how much time, how many tokens, and roughly how much money each repository has consumed.

It observes passively through Claude Code hooks, keeps a small always-on background daemon, and presents a browser dashboard on `localhost`. Optional OS notifications and sounds carry over — and extend — the notifier's idea.

## Problem

Serious Claude Code users rarely run one session. They run several — one per repo, spread across terminals, tabs, and tmux panes. That creates blind spots:

- **Which session is still working, and which is blocked waiting for me?** A session sitting on a permission prompt is stalled until you notice it.
- **How long has this prompt been running?** No single place shows elapsed time across sessions.
- **What is each session actually doing right now** — editing a file, running a build, waiting?
- **What is each project costing me** in time and tokens? Claude Code shows per-session usage, but nothing aggregates *per repository* over a day or a week.

`claude-code-notifier` answers only "does *this one* session need attention right now," and only in the moment — it is per-session and ephemeral. There is no cross-session overview, no history, and no time/token accounting.

## Vision

A single, always-available dashboard — *the cockpit* — that answers at a glance:

- **What's running right now**, where, and for how long (a live ticking timer per active prompt).
- **What each session is currently doing** — the current tool/activity, or that it is idle or blocked.
- **Which sessions are waiting for me**, surfaced first so nothing stalls unnoticed.
- **What each repository has consumed** — active time, prompts, tokens (input / output / cache), and an estimated dollar cost — over today, this week, or all time.
- **Trends over time** — tokens and time per day, activity by hour, top repositories.

Plus the notifier's ambient layer: an OS notification and/or a sound when a session finishes, needs input, fails, or a prompt runs longer than a threshold — each event independently toggle-able, and OS integration entirely opt-in.

## Who it's for

- Power users running **several concurrent Claude Code sessions** who want one place to watch them all.
- People who want **cost and time visibility per project**, for budgeting or client accounting.
- Anyone who wants **ambient awareness** of their sessions without babysitting terminals.

## Core capabilities (in scope)

1. **Live session overview.** Per active session: repository (git root name + full path), branch, status (`running` / `waiting-for-input` / `idle` / `paused` / `error`), the elapsed time of the current prompt (ticking live), and session age.
2. **Live activity detail.** What Claude is doing *now* — the current tool (running `Bash`, editing a file, waiting on a permission prompt) derived from tool-use hooks — not just a running/idle flag.
3. **Per-repository accounting.** Total active time, prompt count, session count (counting only sessions that spent tokens — an opened-but-never-worked session is excluded), token totals (input / output / cache), and an **estimated dollar cost**, with a time-range filter. *Active time* is engaged wall-clock — time a session spent working a turn or running a background workflow — and deliberately **excludes** time spent waiting on you (a permission prompt) or sitting idle, so it reflects real work rather than elapsed clock.
4. **History & trends.** Retained aggregates rendered as charts: tokens and time per day, activity by hour of day, and top repositories by time or tokens.
5. **Session directory.** A newest-first, paginated list of every Claude Code session still on disk **that spent tokens** — read straight from the transcript files, so it covers pre-cockpit and already-ended sessions the accounting store no longer holds. Sessions that spent **0 tokens (and so 0 cost)** — opened but never worked — are filtered out of this list (and out of every session count elsewhere); a session whose transcript can't be read is *unknown*, not zero, so it stays listed with tokens shown as "—". Each row shows the session's AI-generated title, its repository, when it was last active, and its token/cost totals, with live sessions badged active. Because it reads Claude Code's transcripts (not the cockpit's store), it follows Claude Code's retention — a repo cleared from the accounting views still lists its (token-bearing) sessions here. The verbatim last prompt is never shown; only the derived title.
6. **Notifications & sounds.** OS notifications (opt-in, configurable per event) plus in-dashboard sounds, for: session finished, needs input, prompt running too long, and turn failed.
7. **Pause gate.** An optional control-file-based "all-sessions freeze" — one toggle button or slash command instantly blocks every Claude Code session's tool execution via a separate `PreToolUse` gate hook, and resumes all at once when flipped back. The gate is opt-in (`pauseGateEnabled` config), fail-open (missing / garbage control file runs tools), and includes an optional auto-pilot: pause when 5-hour usage crosses a threshold, resume when the window resets. Pause/resume are recorded in the event log and shown on the dashboard and statusline. *Privacy note: pause events carry no message content, only metadata.*
8. **Zero-friction, cross-platform, private.** No native build step, works on macOS / Windows / Linux, and all data stays on your machine.

## Principles

- **Passive and non-intrusive.** The plugin only observes. Hooks do the minimum work and always exit 0 — they never block, slow, or fail a Claude Code session.
- **Local and private.** All data stays on the machine. The dashboard binds to `127.0.0.1` only. **No transcript content is ever stored or served** — only token counts and metadata.
- **Zero-config by default, deep config optional, all in the UI.** Works out of the box; every setting — sound selection, OS- and in-browser-sound toggles, per-event notifications, pricing, and retention — is edited in the dashboard's Settings view, not a separate wizard or hand-edited file.
- **Cross-platform parity** across macOS, Windows, and Linux, with no compiled dependencies and no bundler.
- **Build on proven foundations.** Reuse the notifier's stack — Node.js, `node-notifier`, XDG/APPDATA path handling, JSONL logging, and detached-worker dispatch.
- **Graceful degradation.** If token data or a particular hook is unavailable, show everything else and clearly mark what's missing — never crash, never block.

## Relationship to claude-code-notifier

The cockpit **complements and supersedes** the notifier rather than replacing the idea:

- **Notifier** = single-session, in-the-moment "ping me when this one needs attention."
- **Cockpit** = multi-session overview + per-repo accounting + history, *and* it subsumes the notification capability.

They share design DNA and code patterns. You can run both, but the cockpit's notifications are configurable so you can disable any overlap. If both are enabled with overlapping events, you may receive duplicate notifications — the cockpit's per-event toggles are the way to avoid that.

## Non-goals

- **Not a billing system.** Dollar figures are *estimates* from a configurable pricing table, not authoritative charges.
- **No transcript or message-content viewing.** The cockpit surfaces token counts, tool names, and metadata only — never prompt/response text. The current file or command *can* optionally be shown as activity detail, but that is off by default and never leaves your machine. This is a deliberate privacy boundary.
- **No cloud sync or multi-machine aggregation in v1.** The data model leaves room for it, but a cross-machine view is explicitly out of scope for now.
- **No remote/mobile app.** The dashboard is a local web page. (Viewing it from another device via port-forwarding is possible but unsupported and off by default.)
- **Read-only observability in v1.** The cockpit does not send prompts to, or kill, sessions. Session control is a possible future direction, not a v1 goal.
- **No cross-platform CI in v1** — matches the notifier; manual verification per OS.

## Success criteria

- Open the dashboard and immediately see every active session with a live timer, correct repository name, and current status.
- Per-repo token and time totals that match your intuition of the day's work.
- An OS notification and/or sound fires when a session finishes or needs input — if, and only if, you enabled it.
- You never notice a performance impact on Claude Code, and a hook error never breaks a session.

## Example scenarios

- **Triage.** Three sessions across three repos: two are `running`, one is `waiting-for-input`. The waiting one is highlighted at the top — you jump to that terminal and unblock it instead of discovering it minutes later.
- **A long-runner.** A prompt in `data-pipeline` has been running 8 minutes; a "long-running" notification and a soft chime tell you to check whether it's stuck.
- **End of day.** The per-repo table shows `acme-api` consumed 42 minutes and 3.1M tokens (~$X estimated) today, while `personal-site` barely registered — useful for a client time log.
