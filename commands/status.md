---
description: Show cockpit daemon health, the dashboard URL, and the active session count.
---

Report the current status of the Claude Code Cockpit.

1. Resolve the daemon port and bearer token from the state directory (port falls
   back to `4319`):

   ```
   node -e "const p=require('${CLAUDE_PLUGIN_ROOT}/scripts/paths.js'),fs=require('fs');const port=(()=>{try{return fs.readFileSync(p.portPath(),'utf8').trim()||'4319'}catch{return '4319'}})();let tok='';try{tok=fs.readFileSync(p.tokenPath(),'utf8').trim()}catch{}console.log(JSON.stringify({port,tok}))"
   ```

2. Query the health endpoint (no auth needed):

   ```
   curl -s http://127.0.0.1:<port>/health
   ```

   If the request fails or is empty, report that the daemon is not running and
   suggest running `/cockpit:open` to start it. Stop here in that case.

3. If healthy, fetch a state snapshot (auth required) and count the entries in
   its `sessions` array:

   ```
   curl -s -H "Authorization: Bearer <tok>" http://127.0.0.1:<port>/api/state
   ```

4. Print a short summary: daemon up/down and its `version`, the dashboard URL
   `http://127.0.0.1:<port>/`, and the number of active sessions.
