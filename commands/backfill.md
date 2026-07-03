---
description: Backfill the cockpit dashboard from existing Claude Code transcripts (past sessions' tokens/cost, bucketed by real date).
---

Import historical token usage from transcripts already on disk, so the dashboard
reflects work done in past sessions — not just sessions started after the plugin
was installed. It is idempotent: re-running never double-counts, and it skips
sessions the daemon is already tracking live.

By default it backfills **the current repository**. Backfill **all repositories**
only if the user explicitly asked for everything.

1. Ensure the daemon is running (idempotent; returns immediately):

   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/ensure.js"
   ```

2. Read the daemon's port and auth token from the state directory:

   ```
   node -e "const p=require('${CLAUDE_PLUGIN_ROOT}/scripts/paths.js'),fs=require('fs');const rd=f=>{try{return fs.readFileSync(f,'utf8').trim()}catch{return ''}};process.stdout.write((rd(p.portPath())||'4319')+' '+rd(p.tokenPath()))"
   ```

   The output is `<port> <token>`.

3. POST to the backfill endpoint. **Scope to the current repo** (default) by passing
   its directory; the daemon resolves the git root and imports every past session
   for that repo. Fall back to the shell's working directory so the value is never
   empty — the daemon rejects a blank `cwd` rather than backfilling everything:

   ```
   curl -sS -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
     -X POST "http://127.0.0.1:<PORT>/internal/backfill" \
     -d "{\"cwd\": \"${CLAUDE_PROJECT_DIR:-$PWD}\"}"
   ```

   If (and only if) the user asked to backfill **all** repositories, send `{"all": true}`
   instead (the daemon accepts exactly one of `cwd` or `all`).

4. Parse the JSON response and report the `summary` concisely: number of transcripts
   scanned, sessions ingested (and how many active sessions were skipped), total
   tokens and estimated cost, the per-repo breakdown, and the date range covered.
   Then tell the user the History and Per-repo views now reflect it, at the dashboard
   URL (`/cockpit:open`).

Notes:
- A large **all**-repo backfill reads every transcript and can take a few seconds.
- Backfilled history is bounded by the daemon's `retentionDays` (default 90) — days
  older than that are pruned, and tokens/cost are attributed per day (backfilled
  turns contribute tokens/cost but not prompt counts or active-time, which aren't
  reconstructable from a transcript).
