# AskUserQuestion tool name alone triggers waiting status

`AskUserQuestion`'s `PreToolUse` now enters `waiting` on the tool name alone (v0.27.0,
`aggregate.USER_BLOCKING_TOOLS`), excluding answer time from active time even when Claude Code skips
the follow-up `permission_prompt` Notification it usually fires. `needsInput` now keys off the
running→`waiting` TRANSITION (not the Notification), so a blocking tool pings you exactly once and
matches the browser cue. `ExitPlanMode` stays out — its own Notification already covers it.

<!-- entry 77 -->
