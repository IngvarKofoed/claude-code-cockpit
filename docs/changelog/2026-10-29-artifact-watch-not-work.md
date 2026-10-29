# Artifact watches no longer hold a session Running

A `type: 'monitor'` background task no longer counts toward `bg_agents`. Publishing an Artifact
(a mockup) opens one that never ends, so the session read Running and accrued active time for
the rest of its terminal's life. Extends `2026-09-07-background-shell-exclusion` from shells
to monitors.

## Detail

- **Measured cause.** Each first publish of a new Artifact adds one non-shell registry entry
  that never leaves. It belongs to the Claude Code process, so it survives `/clear`. One flux
  terminal sat at `bg_agents=2` across four sessions. Its spec session logged 4.53h of active
  time over two days against 0.68h with the two watches removed.
- **Source of the type, read from the Claude Code 2.1.312 binary** rather than docs. The artifact
  live watch registers as `monitor_ws` (`persistent`, `ambient`), and the Stop hook maps both
  `monitor_ws` and `monitor_mcp` to `type: 'monitor'`. The payload carries no `ambient` flag.
- **Rejected: excluding only the artifact watch.** Its sole distinguishing field is the free-text
  `description`, which would mean matching Claude Code's wording, and that breaks silently on an
  upgrade. No `monitor` is the session working anyway: the Monitor tool's WebSocket mode and MCP
  monitors also wait on outside events, and the shell Monitor was already excluded as `shell`.
- **Known limit:** a non-persistent WebSocket Monitor that the turn *ends* on is not waited on.
  `bg_shell_ids` holds shells only, so it never joins `shellWait`. Before this change it counted
  until it closed. 30 days of transcripts held no WebSocket Monitor use at all.
- **History is not corrected.** Artifacts first appear in the log on 2026-10-06. The log stores
  counts, not types, so a replay re-derives those days' inflated active time and no rule
  can tell the watch apart after the fact.
- **A card stuck before this change clears at that session's next Stop or SubagentStop.** Those
  are the only events that carry the registry.
- **On this machine the hooks run the working tree.** The marketplace is a `directory` source,
  and the plugin cache holds a stale 0.40.0. `bg_shell_ids` reached the log at 16:09 on
  2026-10-17, before that change's 17:37 commit. So `2026-10-17-background-shell-wait`'s
  "needs a version bump to reach live sessions" holds only for git-marketplace installs.
- **Verified:** 453 `node --test` passes (2 new). `emit.js` smoke test with a monitor + test
  shell + subagent registry gave `bg_tasks=3 bg_agents=1`, kept the shell id, and stored no
  description. **Not verified:** a real artifact session clearing to Idle, since no Stop had
  fired after the edit.
