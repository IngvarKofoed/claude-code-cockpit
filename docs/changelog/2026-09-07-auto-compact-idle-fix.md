# Resumed turn after auto-compact no longer reads idle

A turn resumed after an auto-compact no longer reads Idle while it works. The residual-
`running` settle now fires only on events that can END work (`SETTLING_EVENTS`), never on
`PreToolUse`/`PostToolUse`, which merely report it. A compact emits `SessionStart` and no
fresh `UserPromptSubmit`, so the turn runs with `currentPrompt` null and the old guard
cancelled every `PreToolUse`'s `running`. Cost: that turn shows "working", not "elapsed".

<!-- entry 203 -->
