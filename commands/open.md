---
description: Open the Claude Code Cockpit dashboard in your browser (starting the daemon if needed).
---

Ensure the cockpit daemon is running, then open the dashboard in the browser.

1. Start (or revive) the daemon idempotently — this returns immediately whether
   or not it was already up:

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure.js"
   ```

2. Resolve the port the daemon is listening on. It is written to the port file
   under the state directory; fall back to the default `4319` if the file is
   missing:

   ```
   node -e "const p=require('${CLAUDE_PLUGIN_ROOT}/scripts/paths.js'),fs=require('fs');try{process.stdout.write(fs.readFileSync(p.portPath(),'utf8').trim()||'4319')}catch{process.stdout.write('4319')}"
   ```

3. Open `http://127.0.0.1:<port>/` with the platform-appropriate command:
   `open <url>` on macOS, `start "" <url>` on Windows, `xdg-open <url>` on Linux.

4. Also print the URL so the user can open it manually if the browser does not
   launch (for example over SSH).

All configuration — notifications, sounds, pricing, retention — is edited in the
dashboard's Settings view. There is no separate configure command.
