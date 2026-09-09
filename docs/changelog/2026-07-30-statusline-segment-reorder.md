# Statusline reordered and active-time segment dropped

Reordered the statusline to `cwd · ctx · usage(5h) · tokens · cost · branch · model` (was
`model · repo · branch · tokens · cost · active · ctx · 5h`); the active-time segment was dropped
(with its now-unused `dur()` helper). The cwd segment now shows the directory
where Claude was STARTED — sourced from `workspace.project_dir` (the original project dir), falling back
to `current_dir` then `cwd`, basename only (the three coincide unless a session starts in a subdir/worktree).
Edits the in-repo `statusline/statusline-render.js` — the file the installed `statusLine.command` points at.
Colours unchanged; also merged a duplicate `context_window` read and tightened the segment divider
from `  ·  ` to ` · ` to fit more values on the line.

<!-- entry 47 -->
