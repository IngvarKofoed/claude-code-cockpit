---
description: Stop the Claude Code Cockpit background daemon.
---

Stop the running cockpit daemon.

1. Read the daemon pid from the pid file under the state directory:

   ```
   node -e "const p=require('${CLAUDE_PLUGIN_ROOT}/scripts/paths.js'),fs=require('fs');try{process.stdout.write(fs.readFileSync(p.pidPath(),'utf8').trim())}catch{}"
   ```

   If it is empty or missing, report that the daemon was not running and stop.

2. Send the process SIGTERM so it can clean up its lock, port, and pid files:
   `kill <pid>` on macOS/Linux, or `taskkill /PID <pid>` on Windows.

3. Confirm the daemon has stopped (a follow-up `/cockpit:status` should now show
   it down). The daemon is auto-revived on the next Claude Code `SessionStart`.
