# One canonical stat-column order governs every surface

One canonical stat-column order now governs every accounting surface (v0.14.0; documented in
ARCHITECTURE.md's Dashboard section): `Tokens · Cost · Sessions · Chats · Tools · Agents · Active · Last active`. Each
surface renders the applicable subset in this relative order and omits the rest — never re-orders. Rules:
Sessions is omitted on single-session surfaces (Live card, Sessions row); Cost drops when cost display is
off; the live surfaces (ribbon, cards) drop Last active (status/timer convey currency).
- Repos table reordered to `Repository | Tokens | Cost | Sessions | Chats | Tools | Agents | Active |
  Last active` (was Active-led, near-reverse). Display-only: sort still resolves by column key, default
  stays Active-desc.
- Sessions table reordered to `Name | Repo | Tokens | Cost | Chats | Tools | Agents | Active | Last active`
  and GAINED Chats/Tools/Agents. These are EVENT-derived (same source as the Live card/Repos), NOT counted
  from the transcript — a transcript's raw prompt/tool counts diverge from the cockpit's event counts (e.g.
  7 vs 1 chats, 34 vs 23 tools for one live session) and would contradict every other page. A new
  `aggregate.accumulateSessionStatsFromEvents` returns `{activeMs,chats,tools,agents}` per session off the
  SAME replay as active time (it REPLACES the old `accumulateSessionActiveFromEvents`, now removed — every
  caller reads the richer record); the daemon's per-session index now carries all four. A live session
  shows its live counters; a past observed session the event-log index; a never-observed session
  (pre-install / event-pruned) shows "—" for all four, an observed-but-idle one shows 0 (kept distinct —
  no misleading zero). Sessions-count stays omitted from a session row (meaningless for one session, like
  the card).
- All four EVENT-derived live cells (Active, Chats, Tools, Agents) refresh in place each SSE frame via
  `refreshLiveStatCells` (renamed from `refreshLiveActiveCells`, which touched only Active). Without it
  Tools/Agents froze at turn-start on a live row — the rebuild signature keys off status/timer-anchor,
  which tool/subagent counts don't move — so the row disagreed with its Live card mid-turn. Tokens/cost
  are deliberately NOT refreshed (transcript-sourced snapshots, only change on refetch).

<!-- entry 50 -->
