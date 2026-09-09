# Review happens once, at the commit

The review point is now the commit, not every non-trivial edit. A commit request against a
non-trivial working tree asks first — `/code-review high --fix`, `/fix-code --fix`, or commit
as-is — and the agent runs the chosen pass itself. The end-of-turn nudge to go run a separate
review is gone. Tests, the smoke test and the browser verification still run per change.

## Detail

- **Why the per-edit mandate went.** A pass fired after every non-trivial edit only ever sees its own
  turn's edits, reviews them from inside the context that just wrote them, and the next follow-up
  re-opens what it just looked at. The accumulated diff at the commit is the first point where the
  change can be read as one thing, which is what a review needs.
- **The gate covers delegated commits too** — `/git commit` and `/git commitandpush` are checked before
  handing off, since the committing subagent never sees this rule.
- **Verification is explicitly not deferred.** Only the review waits for the commit; `node --test`, the
  `emit.js` stdin smoke test, and `web/CLAUDE.md`'s Playwright verification still run per change. A file
  that reads as though checking also waits is the failure mode this carve-out exists to prevent.
- **Two review options, deep first, each labelled with the path that actually runs.** `/code-review` ships
  with the harness so option 1 always works, and its `high` is pinned because the command otherwise reuses
  whatever level was typed last. `/fix-code` is an installed skill; if a checkout lacks it, option 2
  becomes the same review run inline — the review never goes dead, it only changes who performs it.
- **A fan-out's landed diff is nobody's reviewed work**, so *Multi-agent workflows* now points back at the
  gate: no subagent saw the combined change, and a review stage inside a workflow only checked its own
  findings. That earns no extra pass on return — it makes the deep option the right pick at the gate.
