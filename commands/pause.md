---
description: Pause all Claude Code tool execution via the cockpit gate.
---

Pause all tool execution globally via the pause gate.

1. Run the pause CLI. It writes the pause control file (the sole ruler — the gate reads it
   directly, so the pause takes effect whether or not the daemon is running) and best-effort
   nudges the daemon so the dashboard updates instantly. Cross-platform (no `curl`):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/pause-cli.js" pause
   ```

2. Report the result printed by the command. Note that only `/cockpit:resume`, the dashboard
   Resume button, or manually editing the control file resumes execution — a chat prompt
   cannot. The pause gate must be enabled in the dashboard's Settings for it to actually block
   tool execution (when it is off, arming the control file has no effect — the gate fails open).
