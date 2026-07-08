# claude-code-cockpit

A Claude Code plugin providing a live, cross-platform dashboard of all running Claude Code sessions — status, elapsed time, and per-repository token/time/cost accounting — with optional OS notifications and sounds.

## Always read first

Before doing any work in this repo, **always read all** of these:

- @docs/CONCEPT.md — what the cockpit does at the domain level: the live multi-session overview, session/prompt/repo entities and their status lifecycle (`running` / `waiting-for-input` / `idle` / `error`), per-repository accounting, and the notification events.
- @docs/ARCHITECTURE.md — how it's built: Node hook scripts → durable JSONL event log → an always-on localhost daemon that serves a buildless web dashboard over SSE; `node-notifier` for OS notifications; the per-session state model and project layout.
- @docs/CHANGELOG.md — running log of changes to this project.

`CONCEPT.md` and `ARCHITECTURE.md` are the source of truth for *what* we're building, what we've built, and *how* it's structured. If something in the code contradicts them, either the code or the doc is wrong — flag it rather than guessing.

## Changelog discipline

Every change you make to this repository must be recorded in `docs/CHANGELOG.md`.

- Each entry is numbered with a monotonically increasing integer (1, 2, 3, ...). Never reuse or reorder numbers.
- Append new entries to the end of the file.
- Write each entry as **durable project memory, not a recap of the diff**: record what is now *true that wasn't before* — new behavior, state, or rule — plus, in a clause and only when it isn't obvious, the *why*, the alternative you rejected (so a future agent doesn't re-introduce it), or a known limit / deferred follow-up. Skip filenames, mechanical edits, and refactors with no behavior change; the diff and commit already hold those. Self-check: *if a future agent reads this entry before the code, does it learn what changed, why it matters, or what's now safe to assume?* If not, it's noise.
- Keep each entry to **1–5 lines, ~20 words per line at most**. The changelog is read at session start to orient — that only works if it stays scannable. The failure mode to avoid is cramming everything onto one unbroken line: a 40-word run-on isn't a short entry, it just hides the bulk on a single line. Break it into a few short lines instead; and if it sprawls past ~5 lines, that's a signal it's really several changes — give each its own numbered entry.
- Write the entry as part of the same change. Do not batch multiple changes into one entry, and do not skip entries.
- When a phase/increment completes, its per-task entries move to `docs/CHANGELOG-archive.md`, leaving only the milestone summary in `docs/CHANGELOG.md`. Numbers are globally unique across both files — never reuse one that already appears in either.

Same change, bad vs. good entry:

- **Bad** (short, but just recaps the diff — zero orientation value): `42. Updated auth files, reworked middleware, added tests, renamed AuthHelper.`
- **Good** (states what's now true, with the why in a clause):
  ```
  42. Auth now rejects expired refresh tokens before session lookup; stale sessions can no longer silently renew.
      Validated at the middleware boundary so handlers can assume requests are current.
  ```

## Nested guidance

Each code subtree has its own `CLAUDE.md` with scoped tool/skill rules — read the one for the area you're working in:

- `scripts/CLAUDE.md` — the Node.js side: the always-on daemon, hook entry scripts, and the pure core modules (aggregation, transcript parsing, repo resolution, pricing). Tests run with `node --test`.
- `web/CLAUDE.md` — the buildless browser dashboard: HTML/CSS/ES-module SPA, SSE client, inline-SVG charts. Verified in a real browser.

## After making changes

After a non-trivial edit, invoke the **`code-review`** skill with the `high --fix` arguments to review the touched code for correctness, reuse, clarity, and efficiency, then apply every finding to the working tree automatically. It does not auto-trigger — you must invoke it explicitly.

Once the fixes are applied, report what changed:

1. **Group the applied fixes by severity** — blockers (correctness bugs, data loss, security), should-fix (clear improvements, missed reuse), nits (style, naming, minor clarity).
2. **Summarize each bucket in one line** so the user can see what was fixed without expanding every finding.
3. Do not stop to ask which to fix — all findings are fixed by default. The user can review the diff and revert anything they disagree with.

## Multi-agent workflows

When you fan a task out across subagents — the Workflow tool ("ultracode") — tier each agent's model and reasoning effort to the work, so cost tracks value instead of every agent defaulting to the strongest (most expensive) model:

- **Strongest model** (the session model) — contracts, correctness-critical implementation, adversarial review (finding unknown problems), and any verification or synthesis that needs design judgment or where a wrong call silently drops a real defect (security, data-integrity, correctness blockers). Never downgrade these; they are where quality is won or lost.
- **Mid model** — build/test runners, straightforward mechanical implementation, verifying concrete already-stated findings (the review did the catching), and applying already-decided fixes.
- **Cheapest model + low effort** — docs/changelog, i18n, styling, and other boilerplate.

The guardrail: the stage that *catches* an unknown problem (review) stays strong; a stage that only *checks* or *applies* an already-identified one drops a tier by default — escalate a verifier back to the strong model only for subtle or security-/data-integrity-critical findings. For a small finding set, fold verification into the fix-apply agent (verify-and-fix in one pass) rather than one strong agent per finding. Set this per `agent()` call (`model` / `effort`); an agent that omits `model` inherits the session model, which is why an untiered fan-out silently runs everything on the most expensive tier.

**Invoking a named workflow is not authoring one.** The tiers above are yours to set only when *you* write the `agent()` calls. A built-in or named workflow — e.g. `Workflow({ name: 'code-review' })` — runs its own stages on the session model; nothing tiers them for you, so a wide fan-out (the review's per-`(file,line)` verifiers most of all) silently bills every agent at the top tier. Before launching one at `high`+ effort or over a broad diff, check the `scriptPath` the run reports: if a large *checking* stage isn't tiered, edit that script to drop those agents to the mid model (leaving the finders and final synthesis strong) and re-invoke with `{ scriptPath }` instead. Keep them strong only when the diff is security-/data-integrity-critical. For `code-review` specifically: its verifier agents default to the mid model.

This section is inert unless you actually run a multi-agent workflow.

## Git workflow

**Direct to `main`** — when you commit, commit straight to `main`; don't open branches or PRs unless asked. Leave pushing to the user unless they ask you to push.

**This setting only chooses *where* commits go — not *when* to make them.** Commit only when the user asks; finishing a change is not a cue to commit it. When you do commit, each commit is one complete change including its `docs/CHANGELOG.md` entry — never leave the tree half-committed.

<!-- Add additional sections below as the project develops:
  - Project-specific forcing rules (e.g., "Check in with the user before making CSS / layout / UX changes")
  - Destructive-operation guidance if the agent's defaults aren't enough
  - Naming conventions, code-organization rules
-->
