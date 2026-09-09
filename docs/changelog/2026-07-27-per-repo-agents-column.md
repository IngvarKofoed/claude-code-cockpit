# Per-repo table gains an Agents column

Per-repo table gained an Agents column (subagents spawned, `SubagentStart`-derived), between Tokens and
Tools — mirroring the Live card's Agents·Tools pairing. Exposed as `subagents` on both the today
(`reposSummary`) and historical (`/api/history` topRepos) paths; already aggregated per repo in the rollup,
just not surfaced. Event-derived like Chats/Sessions/Tools, so backfill-only days show 0.

<!-- entry 33 -->
