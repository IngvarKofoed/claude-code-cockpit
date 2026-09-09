# claude-code-cockpit

A Claude Code plugin providing a live, cross-platform dashboard of all running Claude Code sessions — status, elapsed time, and per-repository token/time/cost accounting — with optional OS notifications and sounds.

## Always read first

Before doing any work in this repo, **always read all** of these:

- @docs/CONCEPT.md — what the cockpit does at the domain level: the live multi-session overview, session/prompt/repo entities and their status lifecycle (`running` / `waiting-for-input` / `idle` / `error`), per-repository accounting, and the notification events.
- @docs/ARCHITECTURE.md — how it's built: Node hook scripts → durable JSONL event log → an always-on localhost daemon that serves a buildless web dashboard over SSE; `node-notifier` for OS notifications; the per-session state model and project layout.

Then the changelog, as **actions** rather than loads — no `@`-reference can express "the files of a folder", so this part is yours to fetch. There is no summary file to load in its place: `docs/changelog/` is the entire record, and these steps are the only way into it.

1. `ls docs/changelog` — the index, **in full, not a tail**, so that every entry the project has ever written is named once: recent work at the bottom, everything older above it. Each entry is its own file, `YYYY-MM-DD-<slug>.md`. This is not free — it costs roughly a dozen tokens per entry and grows for the life of the repo — but a name is the cheapest possible handle on an entry, and being able to see that something exists is what makes step 4 findable rather than guesswork. Past **~1000 entries** the balance tips: hand the full listing to step 3's subagent instead and read a generous tail here. An absent folder just means no entries yet.
2. Read the **newest 10** in full, or **everything from the last seven days**, whichever is more. Ten is a **floor, not a measure**: at four changes a day it is two days of memory, and in a heavy week barely one. Step 1 already gave you the dates, so you can see which of those two the floor lands on before you start — and if the work you are about to do reaches back further than either, keep reading back until it doesn't.
3. **Delegate a digest of everything behind the window** to a cheap, fast subagent (Haiku or equivalent) — never the main session, since the whole point is that the reading cost lands somewhere other than this context. **Skip this step** when delegating to a subagent isn't available here, or when step 1 showed little behind the window — with thirty entries the window already covers the repo and there is nothing to summarize. Give the subagent `ls -r docs/changelog | tail -n +11` (every entry older than the ten you just read, newest first; written this way because a negative `head -n` count is GNU-only and errors out on macOS) and this brief: read each **lead**, open a `## Detail` only when the lead signals a decision, and return **at most 20 lines** of what a session must not re-litigate — a decision with a rejected alternative, something tried and removed, a constraint that still binds, an entry that reversed an earlier one. Not a recap of what changed; the entries are already that. Leads are 1–5 lines by rule, so this stays affordable across the whole history rather than a recent band. **Never write its output to a file.** Regenerating it per session is what makes it unable to rot, and what keeps anything in git from contending for it.
4. **Before you touch an area, grep the folder for it** — `grep -rli <term> docs/changelog/`, using the words you would pick to describe what you are about to change. This is the only path to a decision made months ago, and the index in step 1 is what tells you which terms are worth trying.

**The grep is not optional and it is not a fallback**, with or without the delegated digest. Nothing here will *show* you a decision from six months back on its own — the index names it, the grep opens it, and skipping both means re-litigating it with nothing signalling that anything is missing. The digest helps but does not replace it: 20 lines distilled from hundreds of leads is necessarily lossy, and it reads leads rather than detail, so the thing you need may be in a `## Detail` it never opened. So before you write a changelog entry, confirm you did both: *did I list `docs/changelog/` this session, and grep it for what I touched?*

`CONCEPT.md` and `ARCHITECTURE.md` are the source of truth for *what* we're building, what we've built, and *how* it's structured. If something in the code contradicts them, either the code or the doc is wrong — flag it rather than guessing.

## Changelog discipline

Every change you make to this repository must be recorded in `docs/changelog/` as **its own file**, named `YYYY-MM-DD-<slug>.md` — the date you write it, then a 2–4 word kebab-case slug. Same shape as `docs/specs/`. There is no single changelog file and there are no entry numbers: one file per change is what makes two parallel changes unable to collide, because no two can reach for the same path.

- **The file has two tiers, bounded differently.** A `#` heading, then a **lead** of **1–5 lines, ~20 words per line at most** — never one packed run-on line, since a 40-word run-on isn't a short entry, it just hides the bulk on a single line. Below it, a **`## Detail`** section — **owed whenever one of these exists, omitted only when none does**: an alternative you rejected (so nobody re-introduces it), a constraint that still binds, a known limit or deferred follow-up, a gap a future session would otherwise assume your verification covered. Write it now or not at all: these live in the context of the session that made the change and are gone when it ends, which is why the section is owed here rather than merely allowed. **It never restates the lead** — padding, not omission, is what goes wrong with a section nothing bounds by length. The lead is bounded because it is what a session reads to orient; the detail is bounded by *purpose*, because nothing else bounds it now that entries no longer share a file. Past ~40 lines of detail the change wanted a spec — write one in `docs/specs/` and link it.
- **Write the lead as durable project memory, not a recap of the diff**: what is now *true that wasn't before* — new behavior, state, or rule — plus, in a clause and only when it isn't obvious, the *why*. Skip filenames, mechanical edits, and refactors with no behavior change; the diff and commit already hold those. Self-check: *if a future agent reads this before the code, does it learn what changed, why it matters, or what's now safe to assume?* If not, it's noise.
- **A landed entry file is never renamed, moved, or deleted.** Its path is its address — other docs, specs and code comments cite it by slug — and this is the one thing here that can break silently. Two changes claiming the same path is a merge conflict, which git blocks; a rename produces no conflict and breaks every citation to that entry with nothing noticing. **Cite in the other direction too:** when your change revisits, narrows or reverses a decision an earlier entry recorded, name that entry's slug in yours. That makes the chain greppable instead of something a future session has to reconstruct — and with no digest carrying it, this is *the* mechanism by which rationale reaches back past the recent window, without any entry growing.
- Write the entry as part of the same change. One file per change: don't batch several changes into one file, and don't skip entries. If a change is genuinely several, give each its own file.
- **Where `HEAD` is doesn't matter.** On `main` or on any branch, the entry file is written the same way, with nothing staged or moved at any point, because the file you write is the file that lands.
- **Write so the index and a grep can find it, because nothing else will.** There is no digest and no curated decision list — deliberately, since any such file is one every change appends to and every compaction rewrites, which is the collision the folder exists to remove. Your entry file is the only copy, reachable exactly two ways: by its slug in `ls docs/changelog`, and by grep over the folder. So the **slug names the thing, not the activity** — `expired-refresh-tokens`, not `auth-fixes` — because the slug is the only part of your entry every future session sees. And when the change carries a decision that must not be re-litigated, say it in the words someone would search for: name the alternative you rejected, the constraint that still binds, the thing you tried and removed. Don't allude to it. An entry nobody can find is an entry nobody wrote.

**Entries predating the folder carry synthetic dates.** This project ran a single numbered `docs/CHANGELOG.md` until it was split into per-entry files. Those 208 backfilled entries have dates that are **ordered and roughly right, but not real** — they were spread evenly across the repo's life, so an entry citing a dated `docs/specs/…` path may disagree with its own filename. Each one carries a marker line, `<!-- entry 134 -->`, recording the number it came from. **An `entry N` citation — and the text of those entries is full of them — resolves by grep:** `grep -rl 'entry 134' docs/changelog/`. New entries have real dates and no marker.

Same change, bad vs. good entry — `docs/changelog/2026-03-14-expired-refresh-tokens.md`:

- **Bad** (short, but just recaps the diff — zero orientation value):
  ```
  # Auth changes

  Updated auth files, reworked middleware, added tests, renamed AuthHelper.
  ```
- **Good** (states what's now true, with the why in a clause, and puts the rejected alternative where it can't rot):
  ```
  # Expired refresh tokens rejected before session lookup

  Auth now rejects expired refresh tokens before session lookup; stale sessions can
  no longer silently renew. Validated at the middleware boundary, so handlers can
  assume every request they see is current.

  ## Detail
  - Rejected checking this in the session store: the store can't tell "expired" from
    "never existed", so the error the client got would have been wrong.
  ```

## Nested guidance

Each code subtree has its own `CLAUDE.md` with scoped tool/skill rules — read the one for the area you're working in:

- `scripts/CLAUDE.md` — the Node.js side: the always-on daemon, hook entry scripts, and the pure core modules (aggregation, transcript parsing, repo resolution, pricing, usage, pause). Tests run with `node --test`.
- `web/CLAUDE.md` — the buildless browser dashboard: HTML/CSS/ES-module SPA, SSE client, inline-SVG charts. Verified in a real browser.

## Reviewing changes

**This repo has exactly one review point: the commit.** Do not review after every edit, and do not run an unrequested review pass mid-session. A pass per prompt costs more than it catches — it only ever sees its own turn's edits, and the next follow-up re-opens what it just looked at.

What does *not* wait for the commit is verifying your own work: run `node --test`, the `emit.js` stdin smoke test, and the browser verification `web/CLAUDE.md` mandates, per change, as always. Deferred here is the *review*, not the checking. Never report a change complete on the grounds that its review comes later.

The commit is the right moment because it's when the diff is sealed into history, and because it's the first point where the accumulated diff can be read as **one change** — which is what a review needs. Reviewed edit-by-edit, from inside the context that just wrote each one, a review sees the least and repeats its own blind spots.

**So when the user asks you to commit (or commit and push) and the working tree holds non-trivial changes, ask before committing** — `AskUserQuestion`, three options in this order:

1. **`/code-review high --fix`** — the deep pass: broad coverage, correctness plus reuse / simplification / efficiency, repairs applied to the working tree.
2. **`/fix-code --fix`** — the tight pass: every finding rated by consequence and independently verified, only the serious and unambiguous ones repaired.
3. **Commit now** — skip the review and go straight to the commit.

The first two are both real reviews; they differ in breadth and cost, not in whether the change gets looked at. **Option 1 leads because it catches the most** — recommend it for the diff this gate usually sees (accumulated over several rounds, or landed by a fan-out), and option 2 when the diff is small, contained, and already well understood.

**You** run the pass; the user is only choosing whether it happens and how deep it goes. This is the one place the review flow stops to ask — there is no end-of-turn nudge to go run a review elsewhere.

- Ask **once per commit request**, not per round or per file. If the user picks a review, run it, report, then continue to the commit without asking again.
- **Skip the question** when the diff is trivial — a typo, a version bump, a changelog entry — or when a full review pass has already covered this working diff since the last edit. Asking there is noise.
- **Any** commit request goes through the gate, including a delegated one (`/git commit`, `/git commitandpush`) — check it before handing off, not after. A skill or subagent that does the committing never sees this rule.
- If the user picks *Commit now*, that's the answer — commit as asked, and don't re-offer or hedge about it afterwards.

### Running the review pass

**Option 1 — `/code-review high --fix`.** It reviews the current diff at high effort: broader coverage than the lower levels, including findings it isn't fully certain of, which is what you want at a gate that fires once per commit. Its brief is wider than option 2's — correctness bugs *and* reuse / simplification / efficiency cleanups in the same pass — and `--fix` applies what it finds to the working tree after the review. Its own report stands; don't restate it. Keep the explicit `high`: without a level the command silently reuses whatever level was typed last. Being the broader path, it will also repair things option 2 would have deliberately left alone, so read the resulting diff before committing rather than assuming every edit was a blocker.

**Option 2 — `/fix-code --fix`.** It resolves the diff scope itself, rates every finding 1–5 by consequence, has an independent verifier refute each one before repairing, takes a restore point first, and applies the repairs that are both serious and unambiguous — reversible via `/fix-code --undo`. Its own report stands; don't restate it. Two things it deliberately does *not* do: it leaves severity-1 and -2 findings unrepaired, and it treats style / naming / reuse as `/simplify`'s job and deep security work as `/security-review`'s. Run those separately if the change warrants them.

**If `fix-code` is ever not installed in a checkout, option 2 is that same review run by you, inline over the working diff.** A missing skill doesn't remove the review — it only changes who performs it. Scale it to the diff:

- **Small, contained diff** — read it yourself in one careful pass.
- **Substantial or complex diff** (what an accumulated multi-round working tree usually is) — fan the review out across **subagents via the Agent tool** (individual agents; this needs no ultracode opt-in — that gate is only for the Workflow tool), **one per dimension that's actually at risk in this diff (typically 2–4)**, then **verify each finding before acting on it**. Review finders run on the strong model; verification can drop a tier (the same tiering as *Multi-agent workflows* below). If the Agent tool isn't available, do the same review yourself in one thorough pass.

Check, across the diff: **correctness, security & data-integrity, edge cases & tests, reuse / duplication, clarity, performance, and conformance to this repo's own conventions** — the CLAUDE.md rules and established patterns, notably the hooks-never-block guarantee, the no-message-content privacy boundary, and the event-log-is-source-of-truth / idempotent-replay invariants. Then **apply every fix to the working tree automatically** and report:

1. **Group the applied fixes by severity** — blockers (correctness bugs, data loss, security), should-fix (clear improvements, missed reuse), nits (style, naming, minor clarity).
2. **Summarize each bucket in one line** so the user can see what was fixed without expanding every finding.
3. Do not stop to ask which to fix — all findings are fixed by default. The user can read the diff and revert anything they disagree with.

Every path closes the same way: say plainly what the review couldn't settle — you guessed at intent, left a known gap, or nothing covers it — so the user knows where their own judgement is still needed. State it as a fact about the change, not as a recommendation to run anything.

## Multi-agent workflows

When you fan a task out across subagents — the Workflow tool ("ultracode") — tier each agent's model and reasoning effort to the work, so cost tracks value instead of every agent defaulting to the strongest (most expensive) model:

- **Strongest model** (the session model) — contracts, correctness-critical implementation, adversarial review (finding unknown problems), and any verification or synthesis that needs design judgment or where a wrong call silently drops a real defect (security, data-integrity, correctness blockers). Never downgrade these; they are where quality is won or lost.
- **Mid model** — build/test runners, straightforward mechanical implementation, verifying concrete already-stated findings (the review did the catching), and applying already-decided fixes.
- **Cheapest model + low effort** — docs/changelog, i18n, styling, and other boilerplate.

The guardrail: the stage that *catches* an unknown problem (review) stays strong; a stage that only *checks* or *applies* an already-identified one drops a tier by default — escalate a verifier back to the strong model only for subtle or security-/data-integrity-critical findings. For a small finding set, fold verification into the fix-apply agent (verify-and-fix in one pass) rather than one strong agent per finding. Set this per `agent()` call (`model` / `effort`); an agent that omits `model` inherits the session model, which is why an untiered fan-out silently runs everything on the most expensive tier.

**Invoking a named workflow is not authoring one.** The tiers above are yours to set only when *you* write the `agent()` calls. A built-in or named workflow — e.g. `Workflow({ name: 'code-review' })` — runs its own stages on the session model; nothing tiers them for you, so a wide fan-out (the review's per-`(file,line)` verifiers most of all) silently bills every agent at the top tier. Size the run before launching it — how many agents the fan-out implies, given the work it's spread over — rather than planning to retier afterwards; editing the `scriptPath` a run reports is a per-run patch, and resuming re-runs every stage from the edited `agent()` call onward, so the untiered agents get billed twice. Keep the checking stages strong only when the diff is security-/data-integrity-critical. For `code-review` specifically: its verifier agents default to the mid model.

**A workflow's aggregate diff is what the review gate is for.** A fan-out edits files across several subagents, so no single agent ever saw the whole combined change, and any review stage *inside* the workflow checked its own findings, not the landed diff. This doesn't earn an extra pass on return; the commit is still the review point. But when the gate asks, say the diff came out of a fan-out — it's where the deep pass earns its cost most clearly, so recommend option 1 there, and if the review falls to the inline path it gets the substantial-diff treatment above even when every agent's own slice looked small.

This section is inert unless you actually run a multi-agent workflow.

## Git workflow

### Where commits land

**Direct to `main`** — when you commit, commit straight to `main`; don't open branches or PRs unless asked. Leave pushing to the user unless they ask you to push.

**This setting only chooses *where* commits go — not *when* to make them.** Commit only when the user asks; finishing a change is not a cue to commit it. When you do commit, each commit is one complete change including its `docs/changelog/` entry file — never leave the tree half-committed.

A commit request first passes through the review gate in *Reviewing changes* above — check it before staging anything.
