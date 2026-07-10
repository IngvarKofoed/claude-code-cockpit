---
description: Resume Claude Code tool execution paused by the cockpit gate.
---

Resume tool execution that the pause gate froze.

1. Run the resume CLI. It writes `running` to the control file (the sole ruler — the gate reads
   it directly, so resumption takes effect whether or not the daemon is running) and best-effort
   nudges the daemon so the dashboard updates instantly. Cross-platform (no `curl`):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pause-cli.js" resume
   ```

2. Report the result printed by the command. Each session's next (or currently blocked) tool
   call proceeds within ~2s, continuing exactly where it was — no context is lost.
