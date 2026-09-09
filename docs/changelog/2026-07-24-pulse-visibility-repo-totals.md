# Status pulse made visible, repo-total row completed

Status-change pulse made clearly visible and the repo-total row completed:
- The pulse now uses a thick ring + a large outer glow + an inner glow (was a faint outer glow only), and
  the running→idle "done" pulse is a BRIGHT sky-blue — the mid accent blue was washing out against the
  dark-blue backdrop.
- The card's muted repo-total row now also shows Agents and Tools totals (it previously stopped after
  Active). Backed by a new per-repo `subagents` count in the rollup (event-derived from `SubagentStart`,
  same unconditional pattern as `byTool`) plus a `tools` = Σ`byTool`, both summed across days and exposed on
  `repoTotals`; `byTool`/`SubagentStart` now invalidate `repoTotalsCache`. Like chats/active, these are
  live-only (no backfill). Reverses the earlier spec non-goal that the total row carried no Agents/Tools cell.

<!-- entry 21 -->
