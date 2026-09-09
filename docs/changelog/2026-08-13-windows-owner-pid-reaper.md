# Dead owner_pid no longer proves a Windows session died

On Windows a dead `owner_pid` no longer counts as evidence a session died, so the reaper falls
through to the generous idle timeout there (`OWNER_PID_IS_EVIDENCE`). Claude Code spawns a FRESH
powershell per hook, so `process.ppid` is a throwaway pid (~136 distinct across 146 events of one
live session) — every Windows session looked dead, and any quiet past the 90s grace was reaped
WHILE RUNNING. It read as benign only because the next event re-registered it: the card vanished
during idle and silently returned on the next keystroke.
Cost: a force-quit Windows session now lingers ~6h instead of 90s. Capturing the real claude.exe
pid would need a PowerShell parent-walk inside a hook while its shell lives — barred by the
hooks-must-never-block rule, and unrecoverable once the hook exits.

<!-- entry 101 -->
